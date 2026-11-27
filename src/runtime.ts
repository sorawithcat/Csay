// Csay 运行时：以 C 源码形式内联进生成文件，不额外产生依赖。

import { RUNTIME_CORE_C } from './runtime/core.ts'
import { RUNTIME_JSON_C } from './runtime/json.ts'
import { RUNTIME_REGEX_C } from './runtime/regex.ts'
import { RUNTIME_STDLIB_C } from './runtime/stdlib.ts'

export const RUNTIME_C = RUNTIME_CORE_C + RUNTIME_REGEX_C + RUNTIME_JSON_C + RUNTIME_STDLIB_C
