# VS Code 自定义编辑器菜单重复项调查

调查日期：2026-08-13  
目标版本：VS Code 1.132.1（commit `c2d1b13fdc4a77628e5f3bb70173351c8f2fbad1`）

## 结论

最可能、且能完整解释现象的根因是：插件为同一个 `viewType` 配置了三个独立的 `selector`，VS Code 因此向编辑器解析服务注册了三次同一个编辑器；当 `workbench.editorAssociations` 又把该 `viewType` 配为当前扩展名的默认编辑器时，VS Code 1.132.1 的资源匹配会让这三次注册全部命中。右上角的编辑器选择菜单通过 `getEditors(resource)` 取得结果，而这个版本在该路径中没有按 `viewType` 去重，于是显示三个完全相同的条目。

三项会同时出现选中/取消状态也是同一根因的强证据：它们的 UI 条目虽然有三份，身份字段却都是同一个 `viewType`（`jsonlViewer.viewer`）。

这更像是 VS Code 菜单/解析器在“多个 selector + 用户关联”组合下的去重缺口，而不是插件注册了三个 provider，也不是三个扩展版本同时运行。

## 证据链

### 1. 插件清单确实包含三个 selector

当前 `package.json` 的一个自定义编辑器贡献包含：

```json
"selector": [
  { "filenamePattern": "*.json" },
  { "filenamePattern": "*.jsonl" },
  { "filenamePattern": "*.ndjson" }
]
```

这完全符合官方 schema：`selector` 是 glob 数组，`viewType` 必须在所有自定义编辑器中唯一。[官方贡献点文档](https://code.visualstudio.com/api/references/contribution-points#contributes.customEditors)；[VS Code 1.132.1 schema 源码](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/contrib/customEditor/common/extensionPoint.ts#L44-L81)

### 2. VS Code 会对 selector 数组中的每个 glob 单独注册一次

`CustomEditorService.registerContributionPoints()` 先遍历自定义编辑器，再遍历它的每个 `selector`，并针对每个 `filenamePattern` 调用一次 `editorResolverService.registerEditor(...)`。三个 selector 因而产生三条注册，它们共享同一个 `id`、label、detail 和 factory。[VS Code 1.132.1 `customEditors.ts`](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/contrib/customEditor/browser/customEditors.ts#L166-L201)

### 3. 配为默认后，同一 viewType 的三条注册都会命中

`findMatchingEditors()` 会遍历所有 glob 下的注册。其 `foundInSettings` 只比较用户关联中的 `viewType` 与注册的 editor id，并不同时验证该关联对应的 filename pattern。只要用户设置中存在 `*.jsonl -> jsonlViewer.viewer`，三条注册的 id 都相同，`foundInSettings` 对三条都为真，因此即使当前资源只直接匹配 `*.jsonl`，`*.json` 和 `*.ndjson` 对应的注册也会一并进入结果。[VS Code 1.132.1 `editorResolverService.ts`](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/services/editor/browser/editorResolverService.ts#L449-L473)

这一点还能解释一个关键现象：若没有设置默认关联，通常只有实际 glob 匹配的那一条；设置默认后才稳定出现三条。

### 4. 右上角菜单所依赖的资源查询没有去重

VS Code 1.132.1 的 `getEditors(resource)` 直接执行 `findMatchingEditors(resource).map(editor => editor.editorInfo)`；只有“查询全部编辑器、不传 resource”的分支按 id 调用了 `distinct(...)`。所以资源查询可以返回三个相同 id。[VS Code 1.132.1 `editorResolverService.ts`](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/services/editor/browser/editorResolverService.ts#L476-L490)

同一文件中的经典 `Reopen Editor With...` Quick Pick 路径却明确写着“不希望出现重复 Id”，并调用 `distinct(registeredEditors, c => c.editorInfo.id)`。这说明 VS Code 自身认可菜单应以 editor id 去重，但不同 UI 路径的处理不一致。[VS Code 1.132.1 `editorResolverService.ts`](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/services/editor/browser/editorResolverService.ts#L780-L800)

### 5. 为什么三项会一起勾选

三次注册都使用贡献的同一个 `viewType` 作为 editor id。当前活动编辑器的身份也是这个 id；右上角 editor type picker 针对查询结果逐项创建 action，但 action id 和 checked 状态都按 editor id 计算。因此三个重复项得到同样的状态，而不是三个真正独立的编辑器。[VS Code 1.132.1 `editorTypePicker.ts`](https://github.com/microsoft/vscode/blob/c2d1b13fdc4a77628e5f3bb70173351c8f2fbad1/src/vs/workbench/browser/parts/editor/editorTypePicker.ts#L35-L55)；[同文件 action/checked 逻辑](https://github.com/microsoft/vscode/blob/c2d1b13fdc4a77628e5f3bb70173351c8f2fbad1/src/vs/workbench/browser/parts/editor/editorTypePicker.ts#L109-L129)

上述注册代码也可见三次调用都使用 `id: contributedEditor.id`；官方文档说明 `viewType` 是 VS Code 在 UI 和实现之间识别该编辑器的唯一标识。[官方 Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors#contribution-point)

### 6. VS Code 主分支已经改变了这条查询路径

调查时的 VS Code `main` 中，右上角 picker 调用 `getEditors` 时传入了过滤选项，而 resolver 对相应分支最终按 editor id 执行 `distinct(...)`。这进一步支持“当前 1.132.1 的菜单查询缺少去重”而非插件提供了三个独立编辑器的判断。[当前 `editorTypePicker.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorTypePicker.ts#L35-L52)；[当前 `editorResolverService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/editor/browser/editorResolverService.ts#L437-L458)

## 建议修复

插件侧最稳妥的规避方式，是把三个 selector 合为一个 brace glob：

```json
"selector": [
  { "filenamePattern": "*.{json,jsonl,ndjson}" }
]
```

这样 VS Code 只注册一次该 `viewType`，仍覆盖三种扩展名，从源头避免重复结果。VS Code 自己的 glob 单元测试明确验证了 `*.{html,js}` brace expansion 能匹配多个扩展名。[VS Code 1.132.1 glob 测试](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/base/test/common/glob.test.ts#L371-L388)

修复后需要重新加载窗口，使静态 contribution point 重新扫描。验证应覆盖：

1. `.json`、`.jsonl`、`.ndjson` 都仍可用该 viewer 打开。
2. 三种扩展名分别设为默认后，右上角只出现一个 `json viewer`。
3. `View: Reopen Editor With...` 和右上角菜单都各只有一个条目。

## 其他可能原因及排除判断

### 低可能：同一个扩展有多个版本或在本地与远程重复安装

这种情况值得检查扩展目录和 profile 的 `extensions.json`，尤其本项目之前出现过 profile 指向旧目录的问题。但它不如 selector 解释有力：VS Code 的 `ContributedCustomEditors` 用 `Map<viewType, CustomEditorInfo>` 保存贡献；重复 id 会打印错误并忽略后加入项，而不是保留三份。[VS Code 1.132.1 `contributedCustomEditors.ts`](https://github.com/microsoft/vscode/blob/1.132.1/src/vs/workbench/contrib/customEditor/common/contributedCustomEditors.ts#L56-L99)

此外，三项完全联动说明身份相同；三个不同安装若真正形成三个不同编辑器，通常要有不同 `viewType`，其状态不会全部联动。

### 低可能：扩展代码重复调用 `registerCustomEditorProvider`

provider 注册发生在扩展激活后，负责实现已声明的 `viewType`。官方文档说明，仅在 UI 展示可用自定义编辑器时甚至无需激活扩展；菜单候选首先来自静态 `customEditors` contribution。因此菜单恰好三项更符合三个 selector 的静态注册，而不是运行时代码重复注册。[官方 Custom Editor API：activation](https://code.visualstudio.com/api/extension-guides/custom-editors#custom-editor-activation)

### 不构成根因：`priority: "option"`

`priority` 只控制是否默认使用及能否作为可选编辑器出现，不会创建额外 editor identity。官方 schema/文档没有把 priority 定义为重复注册机制。[官方贡献点文档](https://code.visualstudio.com/api/references/contribution-points#contributes.customEditors)

### 不构成根因：三个 filename pattern 本身互相重叠

对一个普通 `.jsonl` 文件，`*.json`、`*.jsonl`、`*.ndjson` 并不互相重叠。导致三条都命中的关键是用户关联分支仅按相同 editor id 判断，而不是 glob 的自然匹配。

## 最终判断

置信度：高。

“重复项数量 = selector 数量”“三个条目同步勾选”“设置默认编辑器后用户关联按同一 viewType 命中所有注册”“资源菜单查询不去重”四项证据相互吻合。建议直接合并为单个 brace glob；若合并并重载后仍有重复，再检查 profile 扩展注册表、已安装版本和开发扩展宿主，但它们属于第二顺位排查。
