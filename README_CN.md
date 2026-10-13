[English](README.md)

# EliteScript

为 Elite Robots CS 系列机器人脚本提供 VS Code 语言支持。EliteScript 遵循 Python 缩进规则，并扩展机器人内置函数与可省略的 `end` 块结束标记。

## 功能

- 复用 VS Code 内置 Python 高亮，仅补充 EliteScript 的 `end` 规则。
- 当前作用域变量、自定义函数及 186 个机器人内置函数的智能补全。
- 中英文悬停文档、参数签名提示、Pyright 语法及类型诊断。
- 定义跳转、查找引用、符号重命名、文件大纲和代码块折叠。
- 检查已写出的 `end` 是否多余、缩进错位，以及块关闭后仍出现分支或块内语句的情况。
- 函数、条件、循环和异常处理代码片段。

**`end` 可以省略。** 写出时，应与所属的 `def`、`class`、`if`、`for`、`while`、`try` 或 `with` 头部对齐。`elif/else/except/finally` 与所属结构共用结束标记：

```python
def task():
    target = [0.0, -1.57, 1.57, 0.0, 1.57, 0.0]
    if target:
        movej(target, a=0.5, v=0.2)
    else:
        pass
    end
end
```

去掉两个 `end` 也合法。字符串、注释和续行表达式中的 `end` 不会被删除。

## 安装与配置

通过 **Extensions: Install from VSIX...** 安装打包后的扩展，再打开 `.script` 文件。要求 VS Code 1.95 或更新版本。插件内包含 Pyright，无需另外安装 Python 或 Pylance 扩展；语法高亮需要启用 VS Code 自带的 **Python Language Basics** 扩展。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `elitescript.documentationLanguage` | `auto` | `en`、`cn`，或跟随 VS Code 界面语言 |
| `elitescript.pythonVersion` | `3.8` | 分析使用的 Python 版本，请按控制器实际支持版本设置 |
| `elitescript.typeCheckingMode` | `basic` | `off/basic/standard/strict` 类型检查级别 |

修改配置会重启语言服务器。不同工作区文件夹可以配置不同参数。命令面板保留 **Elite Script: Switch to Chinese / English**，并增加 **Elite Script: Restart Language Server**。

## 实现方式

VS Code 客户端启动 EliteScript LSP 适配层，由适配层启动固定版本的 Pyright：

1. 在扩展全局存储目录中，为当前会话生成独立的分析目录，复制工作区中的 `.script`、`.py`、`.pyi`。`helper.script` 对应分析目录中的 `helper.py`，因此未打开的脚本也能参与导入分析。
2. 将作为块结束标记的 `end` 替换为等长空格，保留行号、UTF-16 位置、注释及换行风格。
3. 从现有 JSON 生成 `__builtins__.pyi`，让机器人 API 无需导入即可参与分析。函数签名统一以英文数据为来源，中英文数据提供对应文档。
4. 将诊断、跳转和重命名编辑映射回原文件。未保存的 EliteScript 缓冲区优先于磁盘内容，关闭缓冲区后恢复已保存的版本。
5. 正常关闭语言服务器时清理当前会话的分析目录。

分析过程不修改源文件，也不修改普通 Python/Pylance 配置。插件使用独立的 Pyright 配置，不读取工作区的 `pyrightconfig.json`。初始扫描跳过符号链接，以及常见依赖、版本控制目录：`node_modules`、`.git`、`.venv`、`venv`、`__pycache__`、`.tox`、`.pytest_cache` 等。测试生成的 `.test-artifacts` 和扩展自身的分析存储目录也会被排除。扫描或文件同步遇到无权限、被占用的源路径时会跳过，并在 **EliteScript** 输出通道记录警告；扫描期间消失的路径会被忽略，不影响其他脚本的分析。

## 当前范围

- 不提供执行、机器人连接、调试、格式化和通用代码修复；运行行为仍需在控制器或仿真器上验证。
- 类型诊断依赖现有 API 数据，尚未检查列表长度、物理单位、机器人限制及不同固件版本的 API 差异。
- 跨文件 `.script` 导入需要打开工作区文件夹；单独打开的文件和未命名文件提供单文件智能提示。相对导入应遵循 Python 包目录结构。
- Python 辅助文件从磁盘同步；未保存内容同步针对 EliteScript 缓冲区。同目录存在同名 `helper.script` 与 `helper.py` 时，分析优先使用脚本，建议避免这种歧义。
- 不同工作区根目录使用独立分析环境，暂不处理任意跨根目录脚本导入和控制器特有的模块加载方式。
- 支持桌面及远程工作区扩展宿主，不支持纯浏览器版 VS Code、虚拟工作区和不受信任的工作区。

## 开发与验证

使用 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run package
```

生成安装包 `elitescript-0.1.1.vsix`。运行依赖、Pyright 和其 typeshed 均包含在包内，不能把整个 `node_modules` 排除在 VSIX 之外。

`npm test` 会编译并执行词法适配、内置声明和真实 Pyright LSP 集成测试。高亮组合测试在找到本机 VS Code 的 Python grammar 时执行；自动发现失败时，可将 `VSCODE_PYTHON_GRAMMAR` 设置为内置 `MagicPython.tmLanguage.json` 的路径。

将 `VSCODE_EXECUTABLE` 设置为 VS Code 应用可执行文件路径，再运行 `npm run test:vscode`，可验证实际扩展宿主中的提示、诊断、文档切换与重启。测试打开整个仓库并检查 `examples/demo.script`，使用 `.test-artifacts` 下的独立配置，不使用日常 VS Code 配置。

手工验证时，在扩展开发宿主中打开 `examples/demo.script`。服务端代码位于 `src/server`，中英文 API 数据保留在 `src/EliteFunctions/en` 和 `src/EliteFunctions/cn`。`syntaxes` 仅保留引用 `source.python` 的小型规则文件，不再维护 MagicPython 副本，也不再需要生成 grammar 的构建步骤。
