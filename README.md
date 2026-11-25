# Csay

Csay 是一门使用中文关键字、语法接近 C# 的静态类型编程语言。源码编译为 C，再生成独立可执行文件，可在 Windows 上直接运行。

## 特性

- 中文关键字，可选分号，支持全角标点
- 类、属性、单继承、虚拟方法与覆盖、接口与运行时分派
- 枚举、数组、`列表<T>`、`表<K,V>`，以及列表别名 `集合<T>`/`队列<T>`/`栈<T>`
- 异常类型与多捕获、`使用` 自动关闭、区域内存分配、文件读写
- 泛型类/结构/接口、静态成员、结构体、访问控制、`密封`/抽象类与抽象方法/`只读`、`引` 多文件
- 委托类型与 Lambda（表达式体/块体，按值捕获局部变量），委托调用空检查
- `断言` 与 `csay --test` 测试运行器
- `csay --project` 多文件工程构建（入口 `主.csay`，`引` 递归加载依赖）
- `--debug` 生成 `#line` 源码映射并传入 `-g`
- `--format` 按规范格式原地重写源文件
- 时间、路径、目录操作、环境变量、系统命令与输出捕获、流式文件、文本格式化、大小写/去空白、轻量正则与 JSON 序列化/解析
- 常用数学/随机函数
- 自举编译器：Csay 能编译自身，C 输出达到固定点

## 安装

### Windows 一键安装

1. 解压发布包 `Csay-0.1.0-win64.zip`。
2. 双击 `安装Csay.bat`。
3. 打开新的终端，运行：

```bat
csay 你的程序.csay
```

安装脚本会：

- 安装到 `%LOCALAPPDATA%\Csay`，不需要管理员权限；
- 使用系统 Node.js 22+，没有时自动下载便携版；
- 把 `csay` 加入用户 PATH；
- 关联 `.csay` 文件；
- 创建开始菜单中的编辑器快捷方式。

### 从源码运行

需要 Node.js 22 或更高版本：

```bat
node src\cli.ts 你的程序.csay
```

仓库自带 TCC，无需另外安装 C 编译器。

## 快速开始

新建 `hello.csay`：

```csay
打印("你好，世界！")
```

编译并运行：

```bat
csay hello.csay
```

常用参数：

```bat
csay hello.csay --check    只检查语法
csay hello.csay --build    只生成 exe
csay hello.csay --fast     使用 TCC，编译更快
csay hello.csay --rebuild  强制重新编译
csay hello.csay --debug    源码行映射 + -g
csay hello.csay --format   原地格式化
csay --project 目录        构建目录下 主.csay 及 引 依赖
csay --test [目录]         递归运行测试，默认 tests
```

生成的 exe 位于 `build\` 目录。

## 编辑器与文档

双击 `编辑器.bat`，或安装后运行 `csay-editor`。启动后不会自动新建文件，编辑器提供：

- 工作区文件树；右键文件、文件夹或空白处打开操作菜单，可新建、重命名、删除、复制路径、在资源管理器中显示；打开文件和文件夹使用系统选择框，不需要手输路径；
- 多标签页编辑，切换标签不会丢失未保存内容；
- 保存、运行、实时语法检查、问题跳转；右键可“转到定义/查找引用/复制”，跨文件跳转；引用结果显示在独立标签页；
- 项目文件 `项目.csayproj` 和项目设置窗口；一键打包到 `dist/<输出名>-<版本>.zip`；
- 输入时自动弹出关键字、内建函数、当前文件词汇补全；输入 `对象.` 时按对象类型优先列出字段和方法；
- 文件筛选、行号、光标位置、自动缩进、注释切换；
- 教程页侧栏支持按章节和小节搜索，正文中的跨文档链接可直接跳转；
- 大文件按可视区域增量语法高亮，滚动和输入保持流畅；
- `F1` 打开教程。

常用快捷键：

| 快捷键 | 功能 |
|---|---|
| `Ctrl+S` | 保存 |
| `Ctrl+Enter` / `F5` | 编译并运行 |
| `Ctrl+N` | 新建文件 |
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+W` | 关闭标签 |
| `Ctrl+/` | 切换行注释 |
| `F12` / `Shift+F12` | 转到定义 / 查找引用 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |

教程源码位于 `docs\教程\`，从基础语法一直讲到标准库参考、工具链与运行时；语言规范和词法文档在 `docs\语言规范.md`、`docs\EBNF与词法-v1.md`。

## 项目结构

```text
src/          TypeScript 编译器：词法、语法、代码生成、运行时；stdlib.ts 是内建函数注册表
selfhost/     用 Csay 编写的自举编译器与运行时头文件
tools/        编辑器、文档服务器、TCC、自举构建脚本
docs/         教程、语言规范、EBNF 与词法
tests/        Csay 回归测试，用 `csay --test tests` 运行
examples/     多文件工程等示例
editors/      VS Code 语法高亮
dist/         打包产物（生成的 zip）
install.ps1   Windows 安装脚本
uninstall.ps1 卸载脚本
```

## 自举

`selfhost/编译器.csay` 是由 Csay 自身编写的编译器。构建流程：

```bat
node tools\自举.mjs
```

该脚本用 Stage 0 编译器构建 Stage 1，再让 Stage 1 编译自身，校验 Stage 2 与 Stage 3 的 C 输出完全一致。

当前自举编译器覆盖教程中的类、泛型、继承、接口、委托、Lambda 与闭包、异常类型与多捕获、`使用` 自动关闭、区域、枚举、数组、列表（含集合/队列/栈别名）、表、结构体和字符串插值等语言特性。

## 卸载

运行安装包中的 `卸载Csay.bat`，或在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

卸载会删除安装目录、用户 PATH 中的 `csay` 路径、文件关联和开始菜单快捷方式。

## 文档

- [教程](docs/教程)
- [语言规范](docs/语言规范.md)
- [EBNF 与词法](docs/EBNF与词法-v1.md)
