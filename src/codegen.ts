// Csay 代码生成器：AST → C 源码。
// 类型用字符串编码，避免引入庞大的联合类型：
//   基本类型  整数 / 浮点数 / 长小数 / 文本 / 真假 / 无
//   数组      整数[] 等
//   对象      类:点 / 结构:点
//   枚举      枚举:星期
//   容器      列表:整数 / 表:文本:整数
//   内置      条目（CsayEntry）/ 异常（CsayStr）
// 遇到真正做不了的东西抛 Unsupported，绝不生成半截错误的 C。

import { Buffer } from 'node:buffer'
import type { CompilationUnit, Stmt, Expr, TypeRef, Param, Accessor, Decl } from './ast.ts'
import { arrangeArguments } from './arguments.ts'
import { RUNTIME_C } from './runtime.ts'
import { expandGenerics } from './generics.ts'

export class Unsupported extends Error {}

type CType = string

function minArgsOf(params: Param[]): number {
  const i = params.findIndex((p) => p.def !== null)
  return i < 0 ? params.length : i
}

const PRIM: Record<string, CType> = {
  '字节': '字节', '有符号字节': '有符号字节',
  '短整数': '短整数', '无符号短整数': '无符号短整数',
  '整数': '整数', '无符号整数': '无符号整数',
  '长整数': '长整数', '无符号长整数': '无符号长整数',
  '浮点数': '浮点数', '长小数': '长小数',
  '文本': '文本', '字符': '字符', '真假': '真假', '无': '无',
}

const INT_CASTS: Record<string, string> = {
  '字节': 'uint8_t', '有符号字节': 'int8_t',
  '短整数': 'int16_t', '无符号短整数': 'uint16_t',
  '整数': 'int32_t', '无符号整数': 'uint32_t',
  '长整数': 'int64_t', '无符号长整数': 'uint64_t',
  '字符': 'uint16_t',
}

function isIntegerType(t: CType): boolean {
  return INT_CASTS[t] !== undefined
}

const ERROR_KINDS: Record<string, number> = {
  '异常': 0, '参数异常': 1, '状态异常': 2, '文件异常': 3, '越界异常': 4, '格式异常': 5,
}

function isErrorType(t: CType): boolean {
  return t === '异常' || t.startsWith('异常:')
}

function errorKindOf(t: CType): number {
  return t.startsWith('异常:') ? ERROR_KINDS[t.slice(3)] : 0
}

type Visibility = '公开' | '私有' | '保护' | '内部'

interface FieldInfo { name: string; cn: string; type: CType; vis: Visibility; isPrivate: boolean; isReadonly: boolean; isConst: boolean; isStatic: boolean; init: Expr | null; constC: string | null }
interface MethodInfo {
  name: string; cn: string; ret: CType; params: CType[]; defaults: (Expr | null)[]; modes: ('ref' | 'out' | null)[]; minArgs: number; isStatic: boolean; vis: Visibility; isPrivate: boolean; raw: any
}
interface PropInfo {
  name: string; type: CType; getCn: string | null; setCn: string | null; vis: Visibility; isPrivate: boolean; isStatic: boolean; raw: any
}
interface CtorInfo { cn: string; initCn: string; params: CType[]; defaults: (Expr | null)[]; modes: ('ref' | 'out' | null)[]; minArgs: number; vis: Visibility; raw: any }
interface IfaceMethod { name: string; cn: string; ret: CType; params: CType[]; modes: ('ref' | 'out' | null)[]; defaults: (Expr | null)[]; minArgs: number; paramNames: string[] }
interface IfaceProp { name: string; type: CType; hasGet: boolean; hasSet: boolean }
interface DelegateInfo { name: string; cn: string; params: CType[]; ret: CType; raw: any; paramNames: string[] }
interface TypeInfo {
  kind: 'class' | 'struct' | 'interface' | 'enum'
  name: string
  cn: string
  base: string | null
  /** 是否抽象类：不能直接 新 */
  isAbstract: boolean
  /** 是否密封类：不能被继承 */
  isSealed: boolean
  /** 实现的接口名，按声明顺序 */
  impls: string[]
  fields: FieldInfo[]
  methods: MethodInfo[]
  props: PropInfo[]
  ctors: CtorInfo[]
  tag: number
  enumItems: { name: string; cn: string }[]
  /** 仅接口：按声明顺序，索引即虚表槽位 */
  ifaceMethods: IfaceMethod[]
  ifaceProps: IfaceProp[]
}

function strLit(s: string): string {
  const bytes = Buffer.from(s, 'utf8')
  let esc = ''
  for (const b of bytes) esc += '\\' + b.toString(8).padStart(3, '0')
  return `csay_str("${esc}", ${bytes.length})`
}

interface Value { c: string; t: CType; env?: string; direct?: boolean }

/** 收集 Lambda 体内引用到的名字，用于按值捕获外层局部变量。 */
function collectNameRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectNameRefs(item, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (obj.kind === 'name' && typeof obj.name === 'string') out.add(obj.name)
  if (obj.kind === 'this' || obj.kind === 'base') out.add('自')
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'kind' || key === 'loc') continue
    collectNameRefs(value, out)
  }
}

/** 命名空间只做声明分组，编译时展开为同一作用域的声明。 */
function flattenDecls(decls: Decl[]): Decl[] {  const out: Decl[] = []
  for (const d of decls) {
    if (d.kind === 'namespace') out.push(...flattenDecls(d.decls))
    else out.push(d)
  }
  return out
}

interface FuncInfo { cn: string; ret: CType; params: CType[]; defaults: (Expr | null)[]; minArgs: number; paramNames: string[]; modes: ('ref' | 'out' | null)[] }

export class CodeGen {
  private out: string[] = []
  private names = new Map<string, string>()
  private counter = 0
  private scopes: Map<string, CType>[] = [new Map()]
  private funcs = new Map<string, FuncInfo[]>()
  private refNames = new Map<string, string>()
  private types = new Map<string, TypeInfo>()
  /** 命名空间限定的类型名（A.B.C）→ 实际类型名。 */
  private typeAliases = new Map<string, string>()
  private delegates = new Map<string, DelegateInfo>()
  private delegateOrder: DelegateInfo[] = []
  private lambdaProtos: string[] = []
  private lambdaBodies: string[] = []
  private lambdaCounter = 0
  private lambdaBlockRet: CType | null = null
  private file: string
  private debug: boolean
  private indent = 0
  private selfType: string | null = null
  private inCtor = false
  private currentRet: CType | null = null
  /**
   * 当前嵌套的区域块。控制流提前离开时（返回/跳出/跳过），要在这里逐个 end，
   * 否则区域栈会错位，后面的分配全进错地方。
   * loopDepth 记录进入区域时处在第几层循环，用来判断跳出是否真的离开了它。
   */
  private regionStack: { id: string; loopDepth: number }[] = []
  /** 当前嵌套的 使用 块；提前返回/跳出时要先调用对应的 关闭()。 */
  private usingStack: { close: string; closed: string; loopDepth: number }[] = []
  private usingDepth = 0
  private loopDepth = 0
  /** 当前正在生成的方法所属的类，方法表供裸调用同类方法使用 */
  private classMethods: Map<string, { name: string; ret: CType; params: CType[]; defaults: (Expr | null)[]; modes: ('ref' | 'out' | null)[]; minArgs: number; cn: string; paramNames: string[] }[]> | null = null
  /** 顶层变量提升成 C 全局变量，函数里可以读写 */
  private globalNames = new Set<string>()

  constructor(file: string, debug = false) {
    this.file = file
    this.debug = debug
  }

  // ---------------- 基础设施 ----------------

  private push(line: string): void {
    this.out.push('    '.repeat(this.indent) + line)
  }

  private fresh(prefix: string): string {
    return prefix + this.counter++
  }

  private cname(cn: string): string {
    const ref = this.refNames.get(cn)
    if (ref !== undefined) return ref
    let v = this.names.get(cn)
    if (v === undefined) {
      v = 'n' + this.counter++
      this.names.set(cn, v)
    }
    return v
  }

  private declareVar(cn: string, t: CType): void {
    this.scopes[this.scopes.length - 1].set(cn, t)
  }

  private lookup(cn: string): CType | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i].get(cn)
      if (t !== undefined) return t
    }
    return undefined
  }

  private enter(): void { this.scopes.push(new Map()) }
  private leave(): void { this.scopes.pop() }

  // ---------------- 类型 ----------------

  private resolveType(t: TypeRef): CType {
    if (t.kind === 'array') return `${this.resolveType(t.elem)}[]`
    const alias = this.typeAliases.get(t.name)
    if (alias !== undefined && t.typeArgs.length === 0) return alias
    if (t.name === '列表' || t.name === '集合' || t.name === '队列' || t.name === '栈') {
      if (t.typeArgs.length !== 1) throw new Unsupported(`${t.name} 需要 1 个类型参数`)
      return `列表:${this.resolveType(t.typeArgs[0])}`
    }
    if (t.name === '表') {
      if (t.typeArgs.length !== 2) throw new Unsupported('表 需要 2 个类型参数')
      const k = this.resolveType(t.typeArgs[0])
      const v = this.resolveType(t.typeArgs[1])
      if (k !== '文本' && k !== '真假' && !isIntegerType(k)) throw new Unsupported('表的键只支持 文本、整数或真假类型')
      const nested = v.startsWith('列表:') || v.startsWith('表:') || v.endsWith('[]')
      if (!nested && !['整数', '浮点数', '长小数', '文本', '字符', '真假'].includes(v)) throw new Unsupported('表的值只支持基本类型、列表、表或数组')
      return `表:${k}:${v}`
    }
    if (t.typeArgs.length > 0) throw new Unsupported('自定义泛型')

    if (ERROR_KINDS[t.name] !== undefined) {
      return t.name === '异常' ? '异常' : `异常:${t.name}`
    }

    const prim = PRIM[t.name]
    if (prim !== undefined) return prim

    if (this.delegates.has(t.name)) return `委托:${t.name}`

    const info = this.types.get(t.name)
    if (info === undefined) throw new Unsupported(`类型「${t.name}」`)
    if (info.kind === 'enum') return `枚举:${info.name}`
    if (info.kind === 'interface') return `接口:${info.name}`
    return `${info.kind === 'class' ? '类' : '结构'}:${info.name}`
  }

  private cType(t: CType): string {
    switch (t) {
      case '字节': case '有符号字节': case '短整数': case '无符号短整数':
      case '整数': case '无符号整数': case '长整数': case '无符号长整数': case '字符':
        return 'CsayInt'
      case '浮点数': return 'CsayFloat32'
      case '长小数': return 'CsayFloat'
      case '文本': return 'CsayStr'
      case '真假': return 'CsayBool'
      case '无': return 'void'
      case '条目': return 'CsayEntry'
      case '异常': return 'CsayError'
      default: break
    }
    if (t.startsWith('异常:')) return 'CsayError'
    if (t.startsWith('条目:')) {
      const [, k, v] = t.split(':')
      return `CsayEntry_${k}_${v}`
    }
    if (t.startsWith('表:')) return 'CsayMap*'
    if (t.endsWith('[]')) return this.cType(t.slice(0, -2)) + '*'
    if (t.startsWith('列表:')) return 'CsayList*'
    if (t.startsWith('委托:')) return this.delegates.get(t.slice(3))!.cn
    if (t.startsWith('枚举:')) return 'Csay_' + t.slice(3)
    if (t.startsWith('接口:')) return 'Csay_' + t.slice(3) + '_Ref'
    if (t.startsWith('类:')) return 'Csay_' + t.slice(2) + '*'
    if (t.startsWith('结构:')) return 'Csay_' + t.slice(3)
    throw new Unsupported(`类型 ${t}`)
  }

  /** JSON序列化 的递归类型描述。 */
  private jsonDesc(t: CType): string | null {
    if (t === '文本') return 's'
    if (t === '字符') return 'c'
    if (isIntegerType(t)) return 'i'
    if (t === '浮点数') return 'f'
    if (t === '长小数') return 'd'
    if (t === '真假') return 'b'
    if (t.startsWith('表:')) {
      const { k, v } = this.mapParts(t)
      const key = k === '文本' ? 's' : k === '真假' ? 'b' : isIntegerType(k) ? 'i' : null
      if (key === null) return null
      const val = this.jsonDesc(v)
      return val === null ? null : 'm' + key + val
    }
    if (t.endsWith('[]')) {
      const elem = this.jsonDesc(t.slice(0, -2))
      return elem === null ? null : 'A' + elem
    }
    if (t.startsWith('列表:')) {
      const elem = this.jsonDesc(t.slice(3))
      return elem === null ? null : 'l' + elem
    }
    return null
  }

  /** 接口引用的 C 类型名，用于构造复合字面量 */
  private refType(t: CType): string {
    return this.cType(t)
  }

  /**
   * 类型适配：把值变成目标类型。
   * 目前只有一种转换——类对象 → 接口引用（带上虚表指针）。
   */
  private delegateThunk(d: DelegateInfo, fn: string): string {
    if (d.params.some((p) => p.endsWith('[]'))) throw new Unsupported('委托的数组参数暂不能直接绑定普通函数')
    const cn = `Csay_delegate_${this.counter++}`
    const params = ['void* env', ...d.params.map((p, i) => `${this.cType(p)} a${i}`)]
    this.lambdaProtos.push(`static ${this.cType(d.ret)} ${cn}(${params.join(', ')});`)
    this.lambdaBodies.push(`static ${this.cType(d.ret)} ${cn}(${params.join(', ')}) {`)
    this.lambdaBodies.push('    (void)env;')
    const call = `${fn}(${d.params.map((_, i) => `a${i}`).join(', ')})`
    this.lambdaBodies.push(d.ret === '无' ? `    ${call};` : `    return ${call};`)
    this.lambdaBodies.push('}')
    this.lambdaBodies.push('')
    return cn
  }

  private coerce(v: Value, target: CType): string {
    if (target.startsWith('委托:')) {
      const d = this.delegates.get(target.slice(3))
      if (d === undefined) throw new Unsupported(`委托 ${target}`)
      if (v.t === target) return v.c
      if (v.c === 'NULL') return `(${this.cType(target)}){ 0 }`
      if (v.t.startsWith('函数:')) {
        const sig = `函数:${d.params.join(',')}->${d.ret}`
        if (v.t !== sig) throw new Unsupported(`函数签名与委托「${d.name}」不一致`)
        if (v.direct === true) {
          const thunk = this.delegateThunk(d, v.c)
          return `(${this.cType(target)}){ 0, ${thunk} }`
        }
        return `(${this.cType(target)}){ ${v.env ?? '0'}, ${v.c} }`
      }
      throw new Unsupported(`把「${v.t}」赋给委托「${d.name}」`)
    }
    if (v.t.startsWith('函数:')) throw new Unsupported('Lambda 只能赋给委托变量或参数')
    if (isErrorType(target)) {
      if (v.c === 'NULL') return 'csay_error_null()'
      if (v.t === '文本') return `csay_error(${v.c}, ${errorKindOf(target)})`
      return v.c
    }
    if (target === '文本' && v.t !== '文本') return this.toStr(v)
    if (isIntegerType(target)) {
      const base = v.t === '文本' ? `csay_str_to_int(${v.c})`
        : (v.t === '浮点数' || v.t === '长小数') ? `((CsayInt)(${v.c}))`
        : v.c
      return `((CsayInt)((${INT_CASTS[target]})(${base})))`
    }
    if (target === '浮点数' && v.t === '文本') return `csay_str_to_float32(${v.c})`
    if (target === '长小数' && v.t === '文本') return `csay_str_to_float(${v.c})`
    if (target === '浮点数' && v.t !== '浮点数') return `((CsayFloat32)(${v.c}))`
    if (target === '长小数' && v.t !== '长小数') return `((CsayFloat)(${v.c}))`
    if (!target.startsWith('接口:')) return v.c
    const iface = target.slice(3)
    if (v.c === 'NULL') return `(${this.refType(target)}){ 0 }`
    if (v.t === target) return v.c
    if (v.t.startsWith('类:')) {
      const cls = this.objName(v.t)
      if (!this.implementsIface(cls, iface)) {
        throw new Unsupported(`类「${cls}」没有实现接口「${iface}」`)
      }
      return `(${this.refType(target)}){ (void*)(${v.c}), &Csay_${cls}_impl_${iface}_VT }`
    }
    throw new Unsupported(`把「${v.t}」赋给接口变量`)
  }

  private defaultOf(t: CType): string {
    if (isIntegerType(t)) return '0'
    if (t === '浮点数') return '0.0f'
    if (t === '长小数') return '0.0'
    if (t === '文本') return 'csay_str("", 0)'
    if (t === '真假') return 'false'
    if (t === '无') return ''
    if (isErrorType(t)) return 'csay_error_null()'
    if (t.startsWith('委托:')) return `(${this.cType(t)}){ 0 }`
    if (t.startsWith('接口:')) return `(${this.cType(t)}){ 0 }`
    return 'NULL'
  }

  private isArray(t: CType): boolean {
    return t.endsWith('[]') && !t.startsWith('表:')
  }
  private isSelfField(name: string): boolean {
    if (this.selfType === null || this.lookup(name) !== undefined) return false
    return this.findField(this.objName(this.selfType), name) !== null
  }
  private isArrayField(e: Expr): boolean {
    return e.kind === 'member' || (e.kind === 'name' && this.isSelfField(e.name))
  }
  private arrayLenOf(e: Expr, v: Value): string {
    if (e.kind === 'name' && !this.isSelfField(e.name)) return `${v.c}_len`
    return `csay_array_len(${v.c})`
  }
  private isObj(t: CType): boolean { return t.startsWith('类:') || t.startsWith('结构:') }
  private isClass(t: CType): boolean { return t.startsWith('类:') }
  private objName(t: CType): string { return t.slice(t.indexOf(':') + 1) }

  private visOf(mods: string[]): Visibility {
    if (mods.includes('私有')) return '私有'
    if (mods.includes('保护')) return '保护'
    if (mods.includes('内部')) return '内部'
    return '公开'
  }

  private classTagPath(info: TypeInfo): string {
    let path = '_tag'
    let cur = info.base
    while (cur !== null) {
      path = 'base.' + path
      const base = this.types.get(cur)
      if (base === undefined) break
      cur = base.base
    }
    return path
  }

  private isSubclassOf(cur: string, owner: string): boolean {
    let c: string | null = cur
    while (c !== null) {
      if (c === owner) return true
      c = this.types.get(c)?.base ?? null
    }
    return false
  }

  private checkAccess(vis: Visibility, owner: string, kind: string, name: string): void {
    if (vis === '公开' || vis === '内部') return
    const cur = this.selfType === null ? null : this.objName(this.selfType)
    if (vis === '保护') {
      if (cur !== null && this.isSubclassOf(cur, owner)) return
      throw new Unsupported(`不能访问保护${kind}「${name}」`)
    }
    if (cur !== null && cur === owner) return
    throw new Unsupported(`不能访问私有${kind}「${name}」`)
  }
  private checkCtorAccess(ctor: CtorInfo, owner: string): void {
    this.checkAccess(ctor.vis, owner, '构造器', owner)
  }

  private typeInfo(t: CType): TypeInfo {
    const info = this.types.get(this.objName(t))
    if (info === undefined) throw new Unsupported(`类型 ${t}`)
    return info
  }

  /** 类（含父类链）声明的全部接口，去重后按发现顺序 */
  private allImpls(className: string): string[] {
    const out: string[] = []
    let cur: string | null = className
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) break
      for (const i of info.impls) if (!out.includes(i)) out.push(i)
      cur = info.base
    }
    return out
  }

  /** 找属性并返回它定义在哪个类，用于虚表跳板转型 */
  private findPropWithOwner(owner: string, name: string): { owner: string; prop: PropInfo } | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const p = info.props.find((x) => x.name === name)
      if (p !== undefined) return { owner: cur, prop: p }
      if (info.base === null) return null
      cur = info.base
    }
    return null
  }

  private findField(owner: string, name: string): { path: string[]; type: CType; name: string; vis: Visibility; isReadonly: boolean; isConst: boolean; constC: string | null; owner: string } | null {
    let cur: string | null = owner
    const path: string[] = []
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const f = info.fields.find((x) => x.name === name && !x.isStatic)
      if (f !== undefined) return { path: [...path, f.cn], type: f.type, name: f.name, vis: f.vis, isReadonly: f.isReadonly, isConst: f.isConst, constC: f.constC, owner: cur }
      if (info.base === null) return null
      const baseInfo = this.types.get(info.base)
      if (baseInfo === undefined || baseInfo.kind === 'interface') return null
      path.push('base')
      cur = info.base
    }
    return null
  }

  private findStaticField(owner: string, name: string): (FieldInfo & { owner: string }) | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const f = info.fields.find((x) => x.name === name && x.isStatic)
      if (f !== undefined) return { ...f, owner: cur }
      if (info.base === null) return null
      const baseInfo = this.types.get(info.base)
      if (baseInfo === undefined || baseInfo.kind === 'interface') return null
      cur = info.base
    }
    return null
  }

  private findStaticProp(owner: string, name: string): (PropInfo & { owner: string }) | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const p = info.props.find((x) => x.name === name && x.isStatic)
      if (p !== undefined) return { ...p, owner: cur }
      if (info.base === null) return null
      const baseInfo = this.types.get(info.base)
      if (baseInfo === undefined || baseInfo.kind === 'interface') return null
      cur = info.base
    }
    return null
  }

  private staticFieldCName(owner: string, field: FieldInfo): string {
    return `${this.types.get(owner)!.cn}_${field.cn}`
  }

  /** 静态字段声明处的初始化表达式，按类型和字段顺序生成一个初始化函数。 */
  private staticInitBodies(): string[] {
    const out: string[] = []
    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      const inits = info.fields.filter((f) => f.isStatic && f.init !== null)
      if (inits.length === 0) continue
      const savedOut = this.out
      const savedSelf = this.selfType
      this.out = []
      this.selfType = info.kind === 'class' ? `类:${info.name}` : `结构:${info.name}`
      this.enter()
      for (const f of inits) {
        const v = this.expr(f.init!)
        this.out.push(`    ${this.staticFieldCName(info.name, f)} = ${this.coerce(v, f.type)};`)
      }
      this.leave()
      out.push(`static void ${info.cn}_static_init(void) {`, ...this.out, '}')
      this.out = savedOut
      this.selfType = savedSelf
    }
    return out
  }

  private findMethodsWithOwner(owner: string, name: string): { owner: string; method: MethodInfo }[] {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return []
      const list = info.methods.filter((x) => x.name === name).map((method) => ({ owner: cur as string, method }))
      if (list.length > 0) return list
      if (info.base === null) return []
      cur = info.base
    }
    return []
  }
  private findMethodWithOwner(owner: string, name: string): { owner: string; method: MethodInfo } | null {
    return this.findMethodsWithOwner(owner, name)[0] ?? null
  }
  private findMethod(owner: string, name: string): MethodInfo | null {
    return this.findMethodsWithOwner(owner, name)[0]?.method ?? null
  }

  private findProp(owner: string, name: string): PropInfo | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const p = info.props.find((x) => x.name === name)
      if (p !== undefined) return p
      if (info.base === null) return null
      cur = info.base
    }
    return null
  }

  // ---------------- 收集 ----------------

  private collect(unit: CompilationUnit): void {
    const decls = flattenDecls(unit.decls)
    for (const d of decls) {
      if (d.kind !== 'delegate') continue
      const info: DelegateInfo = { name: d.name, cn: `Csay_${d.name}`, params: [], ret: '无', raw: d, paramNames: d.params.map((p) => p.name) }
      this.delegates.set(d.name, info)
      this.delegateOrder.push(info)
    }
    // 第一遍：登记名字与种类，先不解析基类（此时后面的类型还没登记）
    for (const d of decls) {
      if (d.kind === 'delegate') continue
      const common = {
        name: d.name, cn: `Csay_${d.name}`, base: null as string | null,
        isAbstract: ('modifiers' in d ? d.modifiers : []).includes('抽象'),
        isSealed: ('modifiers' in d ? d.modifiers : []).includes('密封'),
        impls: [] as string[], fields: [], methods: [], props: [], ctors: [], tag: 0,
        enumItems: [], ifaceMethods: [], ifaceProps: [],
      }
      if (d.kind === 'enum') {
        this.types.set(d.name, {
          ...common, kind: 'enum',
          enumItems: d.items.map((it) => ({ name: it.name, cn: `E_${d.name}_${it.name}` })),
        })
      } else {
        this.types.set(d.name, { ...common, kind: d.kind })
      }
    }

    const addAliases = (list: Decl[], path: string[]): void => {
      for (const d of list) {
        if (d.kind === 'namespace') {
          addAliases(d.decls, [...path, ...d.name.split('.')])
          continue
        }
        const qualified = [...path, d.name].join('.')
        if (d.kind === 'delegate') {
          this.typeAliases.set(qualified, `委托:${d.name}`)
          continue
        }
        const info = this.types.get(d.name)
        if (info === undefined) continue
        const kind = info.kind === 'enum' ? '枚举' : info.kind === 'interface' ? '接口' : info.kind === 'class' ? '类' : '结构'
        this.typeAliases.set(qualified, `${kind}:${info.name}`)
      }
    }
    addAliases(unit.decls, [])

    for (const info of this.delegateOrder) {
      const d = info.raw as Extract<Decl, { kind: 'delegate' }>
      info.params = d.params.map((p) => this.resolveType(p.type))
      info.ret = this.resolveType(d.ret)
    }

    // 第二遍：解析基类与接口（enums/interfaces/classes 都已登记，能正确分类）
    for (const d of decls) {
      if (d.kind !== 'class' && d.kind !== 'struct') continue
      const info = this.types.get(d.name)!
      for (const b of d.bases) {
        if (b.kind !== 'named') throw new Unsupported('泛型基类')
        const bi = this.types.get(b.name)
        if (bi === undefined) throw new Unsupported(`基类型「${b.name}」`)
        if (bi.kind === 'interface') info.impls.push(b.name)
        else if (bi.isSealed) throw new Unsupported(`密封类「${b.name}」不能被继承`)
        else if (info.base === null) info.base = b.name
        else throw new Unsupported('同时继承多个类')
      }
    }

    // 第三遍：成员
    for (const d of decls) {
      if (d.kind !== 'class' && d.kind !== 'struct') continue
      const info = this.types.get(d.name)!
      let fi = 0
      for (const m of d.members) {
        if (m.kind === 'field') {
          const vis = this.visOf(m.modifiers)
          const isStatic = m.modifiers.includes('静态')
          const type = this.resolveType(m.type)
          const isConst = m.modifiers.includes('常')
          const constC = isConst && m.init !== null ? this.coerce(this.expr(m.init), type) : null
          info.fields.push({ name: m.name, cn: `m${fi++}`, type, vis, isPrivate: vis === '私有', isReadonly: m.modifiers.includes('只读') || isConst, isConst, isStatic, init: m.init, constC })
        } else if (m.kind === 'method') {
          const vis = this.visOf(m.modifiers)
          const overloadNo = info.methods.filter((x) => x.name === m.name).length
          info.methods.push({
            name: m.name,
            cn: overloadNo === 0 ? `${info.cn}_${m.name}` : `${info.cn}_${m.name}__${overloadNo + 1}`,
            ret: this.resolveType(m.ret),
            params: m.params.map((p) => this.resolveType(p.type)),
            defaults: m.params.map((p) => p.def),
            modes: m.params.map((p) => p.mode ?? null),
            minArgs: minArgsOf(m.params),
            isStatic: m.modifiers.includes('静态'),
            vis,
            isPrivate: vis === '私有',
            raw: m,
          })
        } else if (m.kind === 'ctor') {
          info.ctors.push({
            cn: `${info.cn}_new`,
            initCn: `${info.cn}_init`,
            params: m.params.map((p) => this.resolveType(p.type)),
            defaults: m.params.map((p) => p.def),
            modes: m.params.map((p) => p.mode ?? null),
            minArgs: minArgsOf(m.params),
            vis: this.visOf(m.modifiers),
            raw: m,
          })
        } else if (m.kind === 'prop') {
          const getA = m.accessors.find((a) => a.kind === 'get')
          const setA = m.accessors.find((a) => a.kind === 'set')
          const vis = this.visOf(m.modifiers)
          info.props.push({
            name: m.name,
            type: this.resolveType(m.type),
            getCn: getA === undefined ? null : `${info.cn}_get_${m.name}`,
            setCn: setA === undefined ? null : `${info.cn}_set_${m.name}`,
            vis,
            isPrivate: vis === '私有',
            isStatic: m.modifiers.includes('静态'),
            raw: m,
          })
        }
      }
    }

    // 覆盖方法必须有可覆盖的父类方法
    for (const info of this.types.values()) {
      if ((info.kind !== 'class' && info.kind !== 'struct') || info.base === null) continue
      for (const m of info.methods) {
        if (!m.raw.modifiers.includes('覆盖')) continue
        let base = this.types.get(info.base)
        let found: MethodInfo | undefined
        while (base !== undefined && found === undefined) {
          found = base.methods.find((x) => x.name === m.name)
          if (found === undefined && base.base !== null) base = this.types.get(base.base)
          else break
        }
        const mods = found === undefined ? [] : found.raw.modifiers
        if (found === undefined || (!mods.includes('虚拟') && !mods.includes('覆盖') && !mods.includes('抽象'))) {
          throw new Unsupported(`方法「${m.name}」标了 覆盖，但父类没有可覆盖的 虚拟 方法`)
        }
      }
    }

    // 抽象方法只能出现在抽象类里，且非抽象类必须实现继承来的抽象方法
    for (const info of this.types.values()) {
      if (info.kind !== 'class') continue
      for (const m of info.methods) {
        if (!m.raw.modifiers.includes('抽象')) continue
        if (!info.isAbstract) throw new Unsupported(`方法「${m.name}」是抽象方法，类「${info.name}」必须也是抽象类`)
        if (m.isStatic) throw new Unsupported(`抽象方法「${m.name}」不能是静态方法`)
      }
      if (info.isAbstract) continue
      let base = info.base
      while (base !== null) {
        const bi = this.types.get(base)
        if (bi === undefined) break
        for (const bm of bi.methods) {
          if (!bm.raw.modifiers.includes('抽象')) continue
          const found = this.findMethodWithOwner(info.name, bm.name)
          if (found === null || found.method.raw.modifiers.includes('抽象')) {
            throw new Unsupported(`类「${info.name}」没有实现抽象方法「${bm.name}」`)
          }
        }
        base = bi.base
      }
    }

    // 第四遍：接口成员，顺序即虚表槽位
    for (const d of decls) {
      if (d.kind !== 'interface') continue
      const info = this.types.get(d.name)!
      for (const m of d.members) {
        if (m.kind === 'ifaceMethod') {
          info.ifaceMethods.push({
            name: m.name,
            cn: `${info.cn}_${m.name}`,
            ret: this.resolveType(m.ret),
            params: m.params.map((p) => this.resolveType(p.type)),
            modes: m.params.map((p) => p.mode ?? null),
            defaults: m.params.map((p) => p.def),
            minArgs: minArgsOf(m.params),
            paramNames: m.params.map((p) => p.name),
          })
        } else if (m.kind === 'ifaceProp') {
          info.ifaceProps.push({
            name: m.name,
            type: this.resolveType(m.type),
            hasGet: m.hasGet,
            hasSet: m.hasSet,
          })
        }
      }
    }

    let classTag = 1
    for (const info of this.types.values()) {
      if (info.kind === 'class') info.tag = classTag++
    }
  }

  /** 类（含父类链）是否实现了某个接口 */
  private implementsIface(className: string, iface: string): boolean {
    let cur: string | null = className
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return false
      if (info.impls.includes(iface)) return true
      cur = info.base
    }
    return false
  }

  /** 找到实现该接口方法的具体方法（沿父类链） */
  private resolveIfaceMethod(className: string, m: IfaceMethod): { owner: string; method: MethodInfo } | null {
    let cur: string | null = className
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const md = info.methods.find((x) => x.name === m.name && x.params.length === m.params.length)
      if (md !== undefined) {
        const sameModes = md.modes.every((x, i) => x === m.modes[i])
        if (!sameModes || md.params.some((x, i) => x !== m.params[i])) return null
        return { owner: cur, method: md }
      }
      cur = info.base
    }
    return null
  }

  // ---------------- 表达式 ----------------

  expr(e: Expr): Value {
    switch (e.kind) {
      case 'int': return { c: `${e.text}LL`, t: '整数' }
      case 'float': return { c: e.text, t: '长小数' }
      case 'char': return { c: `${e.value}LL`, t: '字符' }
      case 'string': return { c: this.interp(e.segs), t: '文本' }
      case 'bool': return { c: e.value ? 'true' : 'false', t: '真假' }
      case 'null': return { c: 'NULL', t: '未知' }
      case 'name': {
        const t = this.lookup(e.name)
        if (t !== undefined) return { c: this.cname(e.name), t }
        // C# 里方法内可以直接写字段名，这里同样允许：名字找不到就找当前类型的成员
        if (this.selfType !== null) {
          const owner = this.objName(this.selfType)
          const sf = this.findStaticField(owner, e.name)
          if (sf !== null) {
            this.checkAccess(sf.vis, sf.owner, '字段', sf.name)
            if (sf.isConst && sf.constC !== null) return { c: sf.constC, t: sf.type }
            return { c: this.staticFieldCName(sf.owner, sf), t: sf.type }
          }
          const field = this.findField(owner, e.name)
          if (field !== null) {
            this.checkAccess(field.vis, field.owner, '字段', field.name)
            if (field.isConst && field.constC !== null) return { c: field.constC, t: field.type }
            const path = 'self->' + field.path.join('.')
            return { c: path, t: field.type }
          }
          const prop = this.findProp(owner, e.name)
          if (prop !== null && prop.getCn !== null) {
            const found = this.findPropWithOwner(owner, e.name)!
            this.checkAccess(prop.vis, found.owner, '属性', prop.name)
            return { c: `${prop.getCn}(${prop.isStatic ? '' : 'self'})`, t: prop.type }
          }
        }
        const fns = this.funcs.get(e.name)
        if (fns !== undefined) {
          if (fns.length !== 1) throw new Unsupported(`重载函数「${e.name}」不能直接作为值`)
          const f = fns[0]
          if (f.modes.some((m) => m !== null)) throw new Unsupported('带引用/输出参数的函数不能直接作为委托值')
          return { c: f.cn, t: `函数:${f.params.join(',')}->${f.ret}`, direct: true }
        }
        throw new Unsupported(`变量「${e.name}」尚未声明`)
      }
      case 'this': {
        if (this.selfType === null) throw new Unsupported('自 只能写在方法里')
        return { c: 'self', t: this.selfType }
      }
      case 'base': {
        if (this.selfType === null) throw new Unsupported('基 只能写在方法里')
        const info = this.typeInfo(this.selfType)
        if (info.base === null) throw new Unsupported('基（当前类型没有父类）')
        const baseInfo = this.types.get(info.base)
        if (baseInfo === undefined) throw new Unsupported('基')
        const bt = `${baseInfo.kind === 'class' ? '类' : '结构'}:${info.base}`
        const cast = baseInfo.kind === 'class' ? `((Csay_${info.base}*)self)` : '(&self->base)'
        return { c: cast, t: bt }
      }
      case 'value': {
        if (this.lookup('__value__') === undefined) throw new Unsupported('值 只能在属性的 写 里用')
        return { c: '_value', t: this.lookup('__value__')! }
      }
      case 'cast': {
        const target = this.resolveType(e.type)
        return { c: this.coerce(this.expr(e.expr), target), t: target }
      }
      case 'paren': return this.expr(e.expr)
      case 'unary': {
        const v = this.expr(e.operand)
        if (e.op === '!') return { c: `(!${v.c})`, t: '真假' }
        if (e.op === '-') return { c: `(-${v.c})`, t: v.t }
        if (e.op === '++' || e.op === '--') return { c: `(${e.op}${v.c})`, t: v.t }
        throw new Unsupported(`前缀运算符 ${e.op}`)
      }
      case 'postfix': {
        // 表下标自增：C 里不存在可写回的表达式，展开成 get + set
        if (e.operand.kind === 'index') {
          const tgt = this.expr(e.operand.target)
          if (tgt.t.startsWith('表:')) {
            const { k, v } = this.mapParts(tgt.t)
            const key = this.expr(e.operand.index)
            const op = e.op === '++' ? '+' : '-'
            return {
              c: this.kvBlock(k, key.c, null, null,
                (kk) => `(csay_map_set(${tgt.c}, &${kk}, &(${this.cType(v)}){ *(${this.cType(v)}*)csay_map_at(${tgt.c}, &${kk}) ${op} 1LL }), 0LL)`),
              t: v,
            }
          }
        }
        const v = this.expr(e.operand)
        return { c: `(${v.c}${e.op})`, t: v.t }
      }
      case 'binary': return this.binary(e.op, e.left, e.right)
      case 'cond': {
        const c = this.expr(e.cond)
        const a = this.expr(e.then)
        const b = this.expr(e.else)
        return { c: `(${c.c} ? ${a.c} : ${b.c})`, t: a.t }
      }
      case 'assign': return this.assign(e)
      case 'call': return this.call(e)
      case 'member': return this.member(e)
      case 'index': return this.index(e)
      case 'new': return this.newObject(e)
      case 'array': {
        if (e.elems.length === 0) throw new Unsupported('空数组字面量')
        const first = this.expr(e.elems[0])
        const elem = first.t
        const items = [this.coerce(first, elem), ...e.elems.slice(1).map((x) => this.coerce(this.expr(x), elem))]
        const elemC = this.cType(elem)
        const tmp = this.fresh('_arr')
        return {
          c: `({ ${elemC}* ${tmp} = (${elemC}*)csay_array_alloc(${items.length}, (int64_t)sizeof(${elemC})); ${items.map((x, i) => `${tmp}[${i}] = ${x};`).join(' ')} ${tmp}; })`,
          t: `${elem}[]`,
        }
      }
      case 'lambda': return this.compileLambda(e)
    }
  }

  /** 生成 Lambda 的 C 包装函数；外层局部变量按值放进环境结构体。 */
  private compileLambda(e: Extract<Expr, { kind: 'lambda' }>): Value {
    const id = this.lambdaCounter++
    const cn = `Csay_lambda_${id}`
    const envCn = `Csay_env_${id}`
    const params = e.params.map((p) => this.resolveType(p.type))

    const names = new Set<string>()
    collectNameRefs(e.body, names)
    const captures: Array<{ name: string; type: CType; c: string; len?: string }> = []
    for (const name of names) {
      if (name === '自') {
        if (this.selfType !== null) captures.push({ name, type: this.selfType, c: 'self' })
        continue
      }
      if (this.scopes[0]?.has(name)) continue
      const t = this.lookup(name)
      if (t === undefined) continue
      captures.push({
        name,
        type: t,
        c: this.cname(name),
        len: t.endsWith('[]') ? this.cname(name) + '_len' : undefined,
      })
    }
    const hasSelf = captures.some((c) => c.name === '自')

    const savedOut = this.out
    const savedIndent = this.indent
    const savedScopes = this.scopes
    const savedRet = this.currentRet
    const savedSelf = this.selfType
    const savedCtor = this.inCtor
    const savedRegion = this.regionStack
    const savedUsing = this.usingDepth
    const savedUsingStack = this.usingStack
    const savedLoop = this.loopDepth
    const savedMethods = this.classMethods
    const savedBlockRet = this.lambdaBlockRet

    this.out = []
    this.indent = 1
    this.scopes = [new Map(this.scopes[0] ?? [])]
    this.currentRet = null
    this.selfType = hasSelf ? savedSelf : null
    this.inCtor = false
    this.regionStack = []
    this.usingDepth = 0
    this.usingStack = []
    this.loopDepth = 0
    this.classMethods = hasSelf ? savedMethods : null
    this.enter()
    params.forEach((t, i) => this.declareVar(e.params[i].name, t))
    for (const c of captures) {
      if (c.name === '自') this.declareVar('自', c.type)
      else this.declareVar(c.name, c.type)
    }
    let ret: CType = '无'
    if (e.body.kind === 'block') {
      this.lambdaBlockRet = (e.retType as CType | undefined) ?? null
      this.currentRet = this.lambdaBlockRet
      for (const st of e.body.stmts) this.stmt(st)
      ret = this.lambdaBlockRet ?? '无'
    } else {
      const v = this.expr(e.body)
      ret = v.t
      this.push(`return ${v.c};`)
    }
    this.leave()
    const body = this.out

    this.out = savedOut
    this.indent = savedIndent
    this.scopes = savedScopes
    this.currentRet = savedRet
    this.selfType = savedSelf
    this.inCtor = savedCtor
    this.regionStack = savedRegion
    this.usingDepth = savedUsing
    this.usingStack = savedUsingStack
    this.loopDepth = savedLoop
    this.classMethods = savedMethods
    this.lambdaBlockRet = savedBlockRet

    const decls = e.params.map((p, i) => `${this.cType(params[i])} ${this.cname(p.name)}`)
    const ps = ['void* env', ...decls].join(', ')
    const bindings: string[] = []
    let env: string | undefined
    if (captures.length > 0) {
      const fields = captures.map((c, i) => `${this.cType(c.type)} c${i};${c.len !== undefined ? ` CsayInt c${i}_len;` : ''}`)
      this.lambdaProtos.push(`typedef struct ${envCn} { ${fields.join(' ')} } ${envCn};`)
      const envParams = captures.map((c, i) => `${this.cType(c.type)} a${i}${c.len !== undefined ? `, CsayInt a${i}_len` : ''}`).join(', ')
      this.lambdaProtos.push(`static void* ${envCn}_alloc(${envParams});`)
      this.lambdaBodies.push(`static void* ${envCn}_alloc(${envParams}) {`)
      this.lambdaBodies.push(`    ${envCn}* e = (${envCn}*)csay_alloc((int64_t)sizeof(${envCn}));`)
      captures.forEach((c, i) => {
        this.lambdaBodies.push(`    e->c${i} = a${i};`)
        if (c.len !== undefined) this.lambdaBodies.push(`    e->c${i}_len = a${i}_len;`)
      })
      this.lambdaBodies.push('    return (void*)e;')
      this.lambdaBodies.push('}')
      this.lambdaBodies.push('')
      bindings.push(`    ${envCn}* e = (${envCn}*)env;`)
      captures.forEach((c, i) => {
        if (c.name === '自') bindings.push(`    ${this.cType(c.type)} self = e->c${i};`)
        else {
          bindings.push(`    ${this.cType(c.type)} ${c.c} = e->c${i};`)
          if (c.len !== undefined) bindings.push(`    CsayInt ${c.c}_len = e->c${i}_len;`)
        }
      })
      env = `${envCn}_alloc(${captures.map((c) => c.len !== undefined ? `${c.c}, ${c.len}` : c.c).join(', ')})`
    } else {
      bindings.push('    (void)env;')
    }
    this.lambdaProtos.push(`static ${this.cType(ret)} ${cn}(${ps});`)
    this.lambdaBodies.push(`static ${this.cType(ret)} ${cn}(${ps}) {`)
    this.lambdaBodies.push(...bindings)
    this.lambdaBodies.push(...body)
    this.lambdaBodies.push('}')
    this.lambdaBodies.push('')
    return { c: cn, t: `函数:${params.join(',')}->${ret}`, env }
  }

  private interp(segs: any[]): string {
    let acc: string | null = null
    for (const seg of segs) {
      const part = seg.kind === 'text' ? strLit(seg.text) : this.toStr(this.expr(seg.expr))
      acc = acc === null ? part : `csay_cat(${acc}, ${part})`
    }
    return acc ?? 'csay_str("", 0)'
  }

  private toStr(v: Value): string {
    if (isErrorType(v.t)) return `${v.c}.msg`
    switch (v.t) {
      case '文本': return v.c
      case '字符': return `csay_char_of_code(${v.c})`
      case '浮点数': return `csay_str_of_float32(${v.c})`
      case '长小数': return `csay_str_of_float(${v.c})`
      case '真假': return `csay_str_of_bool(${v.c})`
      default:
        if (isIntegerType(v.t)) return `csay_str_of_int(${v.c})`
        if (v.t.startsWith('枚举:')) return `csay_str_of_int((CsayInt)(${v.c}))`
        throw new Unsupported('把这种值转成文本')
    }
  }

  private throwValue(v: Value): string {
    if (isErrorType(v.t)) return `csay_throw_error(${v.c})`
    return `csay_throw(${this.toStr(v)})`
  }

  private binary(op: string, le: Expr, re: Expr): Value {
    const l = this.expr(le)
    const r = this.expr(re)
    if (op === '??') {
      if (isErrorType(l.t)) {
        return { c: `csay_error_coalesce(${l.c}, ${this.coerce(r, l.t)})`, t: l.t }
      }
      if (l.t.startsWith('接口:')) {
        const tmp = this.fresh('coalesce')
        return {
          c: `({ ${this.cType(l.t)} ${tmp} = ${l.c}; ${tmp}.obj != NULL ? ${tmp} : ${this.coerce(r, l.t)}; })`,
          t: l.t,
        }
      }
      if (l.t.startsWith('委托:')) {
        const tmp = this.fresh('coalesce')
        return {
          c: `({ ${this.cType(l.t)} ${tmp} = ${l.c}; ${tmp}.fn != NULL ? ${tmp} : ${this.coerce(r, l.t)}; })`,
          t: l.t,
        }
      }
      if (!this.isClass(l.t) && !l.t.startsWith('列表:') && !l.t.startsWith('表:')) {
        throw new Unsupported(`?? 不支持类型 ${l.t}`)
      }
      const tmp = this.fresh('coalesce')
      return {
        c: `({ ${this.cType(l.t)} ${tmp} = ${l.c}; ${tmp} != NULL ? ${tmp} : ${this.coerce(r, l.t)}; })`,
        t: l.t,
      }
    }
    if (op === '==' || op === '!=') {
      const err = isErrorType(l.t) ? l : isErrorType(r.t) ? r : null
      if (err !== null) {
        const target = err.t
        const eq = `csay_error_equal(${this.coerce(l, target)}, ${this.coerce(r, target)})`
        return { c: op === '==' ? eq : `(!${eq})`, t: '真假' }
      }
      if (l.t.startsWith('接口:') && r.t.startsWith('接口:')) {
        const a = this.fresh('itf')
        const b = this.fresh('itf')
        return {
          c: `({ ${this.cType(l.t)} ${a} = ${l.c}; ${this.cType(r.t)} ${b} = ${r.c}; (${a}.obj == ${b}.obj); })`,
          t: '真假',
        }
      }
      const itf = l.t.startsWith('接口:') ? l : r.t.startsWith('接口:') ? r : null
      if (itf !== null) {
        const eq = this.withTemp(itf.t, itf.c, (v) => `(${v}.obj == NULL)`)
        return { c: op === '==' ? eq : `(!${eq})`, t: '真假' }
      }
      if (l.t.startsWith('委托:') && r.t.startsWith('委托:')) {
        const a = this.fresh('dg')
        const b = this.fresh('dg')
        return {
          c: `({ ${this.cType(l.t)} ${a} = ${l.c}; ${this.cType(r.t)} ${b} = ${r.c}; (${a}.fn == ${b}.fn && ${a}.env == ${b}.env); })`,
          t: '真假',
        }
      }
      const dg = l.t.startsWith('委托:') ? l : r.t.startsWith('委托:') ? r : null
      if (dg !== null) {
        const eq = this.withTemp(dg.t, dg.c, (v) => `(${v}.fn == NULL)`)
        return { c: op === '==' ? eq : `(!${eq})`, t: '真假' }
      }
      if (l.t === '文本' || r.t === '文本') {
        const eq = `csay_str_eq(${l.c}, ${r.c})`
        return { c: op === '==' ? eq : `(!${eq})`, t: '真假' }
      }
      return { c: `(${l.c} ${op} ${r.c})`, t: '真假' }
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (l.t === '文本') throw new Unsupported('文本比较大小')
      return { c: `(${l.c} ${op} ${r.c})`, t: '真假' }
    }
    if (op === '&&' || op === '||') return { c: `(${l.c} ${op} ${r.c})`, t: '真假' }
    if (op === '+') {
      if (l.t === '文本' && r.t === '文本') return { c: `csay_cat(${l.c}, ${r.c})`, t: '文本' }
      if (l.t === '文本' || r.t === '文本') throw new Unsupported('文本与数字相加')
    }
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
      const t: CType = l.t === '长小数' || r.t === '长小数'
        ? '长小数'
        : l.t === '浮点数' || r.t === '浮点数'
          ? '浮点数'
          : '整数'
      if (op === '%' && (t === '浮点数' || t === '长小数')) throw new Unsupported('浮点取余')
      return { c: `(${l.c} ${op} ${r.c})`, t }
    }
    throw new Unsupported(`运算符 ${op}`)
  }

  /** 数组参数在 C 里要拆成「指针 + 长度」两个形参 */
  private paramTypes(t: CType, mode?: 'ref' | 'out' | null): string[] {
    if (mode === 'ref' || mode === 'out') return [this.cType(t) + '*']
    if (this.isArray(t)) return [this.cType(t), 'CsayInt']
    return [this.cType(t)]
  }

  private ctorParamTypes(c: CtorInfo): string[] {
    return c.params.map((p, i) => c.modes[i] === 'ref' || c.modes[i] === 'out' ? this.cType(p) + '*' : this.cType(p))
  }

  private methodParamTypes(m: { params: CType[]; modes: ('ref' | 'out' | null)[] }): string[] {
    return m.params.map((p, i) => m.modes[i] === 'ref' || m.modes[i] === 'out' ? this.cType(p) + '*' : this.cType(p))
  }

  private ifaceParamTypes(m: IfaceMethod): string[] {
    return this.methodParamTypes(m)
  }

  private paramDecls(params: Param[], types: CType[]): string[] {
    const out: string[] = []
    params.forEach((p, i) => {
      const cn = p.mode === 'ref' || p.mode === 'out' ? p.name : this.cname(p.name)
      if (p.mode === 'ref' || p.mode === 'out') {
        out.push(`${this.cType(types[i])}* ${cn} /* ${p.name} */`)
      } else if (this.isArray(types[i])) {
        out.push(`${this.cType(types[i])} ${cn} /* ${p.name} */`, `CsayInt ${cn}_len`)
      } else {
        out.push(`${this.cType(types[i])} ${cn} /* ${p.name} */`)
      }
    })
    return out
  }

  /** 实参展开：数组要额外传长度 */
  private callArgs(args: Expr[], targets: CType[], modes: ('ref' | 'out' | null)[] = [], arraysAsPointer = false): string[] {
    const out: string[] = []
    args.forEach((a, i) => {
      if (modes[i] === 'ref' || modes[i] === 'out') {
        if (a.kind !== 'byref' || a.expr.kind !== 'name') throw new Unsupported('引用/输出实参必须是变量')
        out.push('&' + this.cname(a.expr.name))
        return
      }
      if (a.kind === 'byref') throw new Unsupported('参数不是引用/输出参数')
      const v = this.expr(a)
      if (this.isArray(targets[i])) {
        if (!this.isArray(v.t)) throw new Unsupported('数组参数只能传数组变量，不能传字面量')
        if (arraysAsPointer) out.push(v.c)
        else out.push(v.c, this.arrayLenOf(a, v))
      } else {
        out.push(this.coerce(v, targets[i]))
      }
    })
    return out
  }

  /** 省略的实参用声明处的默认表达式补齐；默认值只允许常量表达式 */
  private callArgsWithDefaults(args: Expr[], targets: CType[], defaults: (Expr | null)[], modes: ('ref' | 'out' | null)[] = [], arraysAsPointer = false): string[] {
    const full = args.slice()
    for (let i = full.length; i < targets.length; i++) {
      const d = defaults[i]
      if (d === null || d === undefined) throw new Unsupported('缺少参数')
      full.push(d)
    }
    return this.callArgs(full, targets, modes, arraysAsPointer)
  }

  /** 命名参数按声明顺序重排；调用前已经由语义检查，这里再兜底报错。 */
  private orderedArgs(args: Expr[], names: string[], defaults: (Expr | null)[], what: string): Expr[] {
    const r = arrangeArguments(args, names, defaults)
    if (r.error !== undefined) throw new Unsupported(`${what}${r.error}`)
    return r.args
  }

  private orderedRaw(args: Expr[], params: Param[], defaults: (Expr | null)[], what: string): Expr[] {
    return this.orderedArgs(args, params.map((p) => p.name), defaults, what)
  }

  private objPtr(v: Value): string {
    return this.isClass(v.t) ? v.c : `(&${v.c})`
  }

  /** 表类型的键值类型：'表:文本:整数' → { k:'文本', v:'整数' } */
  private mapParts(t: CType): { k: CType; v: CType } {
    if (!t.startsWith('表:')) throw new Unsupported(`表类型 ${t}`)
    const rest = t.slice(2)
    const i = rest.indexOf(':')
    if (i < 0) throw new Unsupported(`表类型 ${t}`)
    return { k: rest.slice(0, i), v: rest.slice(i + 1) }
  }

  /**
   * 表的读写都要传地址。文本是结构体，没法用复合字面量取地址，
   * 所以统一用 GNU 语句表达式：先在块内落成局部变量，再取地址调用。
   */
  private kvBlock(
    kType: CType, kExpr: string,
    vType: CType | null, vExpr: string | null,
    retFn: (k: string, v: string) => string,
  ): string {
    const k = this.fresh('k')
    const v = this.fresh('v')
    const parts = [`${this.cType(kType)} ${k} = ${kExpr};`]
    if (vType !== null && vExpr !== null) parts.push(`${this.cType(vType)} ${v} = ${vExpr};`)
    parts.push(retFn(k, v) + ';')
    return `({ ${parts.join(' ')} })`
  }

  /** 单个值取地址：同样绕开「文本是结构体」的问题 */
  private withTemp(t: CType, expr: string, retFn: (v: string) => string): string {
    const v = this.fresh('v')
    return `({ ${this.cType(t)} ${v} = ${expr}; ${retFn(v)}; })`
  }

  private assign(e: Extract<Expr, { kind: 'assign' }>): Value {
    if (e.target.kind === 'member') {
      if (e.target.target.kind === 'name') {
        const info = this.types.get(e.target.target.name)
        if (info !== undefined && info.kind !== 'enum' && info.kind !== 'interface') {
          const sf = this.findStaticField(info.name, e.target.name)
          if (sf !== null) {
            this.checkAccess(sf.vis, sf.owner, '字段', sf.name)
            if (sf.isConst) throw new Unsupported(`常字段「${sf.name}」不能赋值`)
            const v = this.coerce(this.expr(e.value), sf.type)
            return { c: `(${this.staticFieldCName(sf.owner, sf)} ${e.op} ${v})`, t: sf.type }
          }
          const sp = this.findStaticProp(info.name, e.target.name)
          if (sp !== null) {
            this.checkAccess(sp.vis, sp.owner, '属性', sp.name)
            if (sp.setCn === null) throw new Unsupported(`属性「${sp.name}」没有 写 访问器`)
            if (e.op !== '=') throw new Unsupported(`静态属性上的 ${e.op}`)
            const v = this.coerce(this.expr(e.value), sp.type)
            return { c: `(${sp.setCn}(${v}), ${v})`, t: sp.type }
          }
        }
      }
      const tgt = this.expr(e.target.target)
      if (tgt.t.startsWith('接口:')) {
        const iface = this.types.get(tgt.t.slice(3))
        if (iface === undefined) throw new Unsupported(`接口 ${tgt.t}`)
        let slot = iface.ifaceMethods.length
        for (const p of iface.ifaceProps) {
          if (p.hasGet) slot++
          if (p.hasSet) {
            if (p.name === e.target.name) {
              if (e.op !== '=') throw new Unsupported(`接口属性上的 ${e.op}`)
              const v = this.expr(e.value)
              return { c: `(${tgt.c}.vt->m${slot}(${tgt.c}.obj, ${v.c}), ${v.c})`, t: p.type }
            }
            slot++
          }
        }
        throw new Unsupported(`接口「${iface.name}」没有可写的属性「${e.target.name}」`)
      }
      if (this.isObj(tgt.t)) {
        const field = this.findField(this.objName(tgt.t), e.target.name)
        if (field !== null) {
          this.checkAccess(field.vis, field.owner, '字段', field.name)
          if (field.isConst) throw new Unsupported(`常字段「${field.name}」不能赋值`)
          if (field.isReadonly && !this.inCtor) throw new Unsupported(`只读字段「${field.name}」只能在构造器里赋值`)
          const path = field.path.join('.')
          const acc = this.isClass(tgt.t) ? `${this.objPtr(tgt)}->${path}` : e.target.target.kind === 'this' ? `self->${path}` : `${tgt.c}.${path}`
          const v = this.coerce(this.expr(e.value), field.type)
          if (e.op !== '=' && field.type.startsWith('委托:')) throw new Unsupported('委托字段只能用 = 赋值')
          return { c: `(${acc} ${e.op} ${v})`, t: field.type }
        }
        const prop = this.findProp(this.objName(tgt.t), e.target.name)
        if (prop !== null) {
          const propOwner = this.findPropWithOwner(this.objName(tgt.t), e.target.name)!
          this.checkAccess(prop.vis, propOwner.owner, '属性', prop.name)
          if (prop.setCn === null) throw new Unsupported(`属性「${prop.name}」没有 写 访问器`)
          if (e.op !== '=') throw new Unsupported(`属性上的 ${e.op}`)
          const v = this.coerce(this.expr(e.value), prop.type)
          return { c: `(${prop.setCn}(${this.objPtr(tgt)}, ${v}), ${v})`, t: prop.type }
        }
      }
    }
    if (e.target.kind === 'index') {
      const tgt = this.expr(e.target.target)
      if (tgt.t.startsWith('表:')) {
        const { k, v } = this.mapParts(tgt.t)
        const key = this.expr(e.target.index)
        const val = this.expr(e.value)
        if (e.op === '=') {
          return {
            c: this.kvBlock(k, key.c, v, val.c,
              (kk, vv) => `(csay_map_set(${tgt.c}, &${kk}, &${vv}), ${vv})`),
            t: v,
          }
        }
        // += -= *= /=：读改写
        const op = e.op.slice(0, -1)
        return {
          c: this.kvBlock(k, key.c, v, val.c,
            (kk, vv) => `(csay_map_set(${tgt.c}, &${kk}, &(${this.cType(v)}){ *(${this.cType(v)}*)csay_map_at(${tgt.c}, &${kk}) ${op} ${vv} }), ${vv})`),
          t: v,
        }
      }
    }
    if (e.target.kind === 'name' && this.selfType !== null && this.lookup(e.target.name) === undefined) {
      const owner = this.objName(this.selfType)
      const field = this.findField(owner, e.target.name)
      if (field !== null) {
        this.checkAccess(field.vis, field.owner, '字段', field.name)
        if (field.isConst) throw new Unsupported(`常字段「${field.name}」不能赋值`)
        if (field.isReadonly && !this.inCtor) throw new Unsupported(`只读字段「${field.name}」只能在构造器里赋值`)
      }
    }
    const target = this.expr(e.target)
    const value = this.expr(e.value)
    if (e.op === '=' && this.isArray(target.t)) {
      const field = this.isArrayField(e.target)
      if (e.value.kind === 'null') {
        return field
          ? { c: `(${target.c} = NULL, NULL)`, t: target.t }
          : { c: `(${target.c} = NULL, ${target.c}_len = 0, NULL)`, t: target.t }
      }
      if (this.isArray(value.t)) {
        if (field) return { c: `(${target.c} = ${value.c}, ${target.c})`, t: target.t }
        if (e.value.kind === 'name') {
          return { c: `(${target.c} = ${value.c}, ${target.c}_len = ${value.c}_len, ${value.c})`, t: target.t }
        }
        return { c: `(${target.c} = ${value.c}, ${target.c}_len = csay_array_len(${target.c}), ${target.c})`, t: target.t }
      }
      if (e.value.kind === 'array') {
        if (field) return { c: `(${target.c} = ${value.c}, ${target.c})`, t: target.t }
        return { c: `(${target.c} = ${value.c}, ${target.c}_len = ${e.value.elems.length}, ${target.c})`, t: target.t }
      }
      throw new Unsupported('数组变量只能赋另一个数组变量、数组字面量或 空')
    }
    if (e.op === '=' && target.t.startsWith('接口:')) {
      return { c: `(${target.c} = ${this.coerce(value, target.t)})`, t: target.t }
    }
    if (e.op === '=' && target.t.startsWith('委托:')) {
      return { c: `(${target.c} = ${this.coerce(value, target.t)})`, t: target.t }
    }
    if (target.t.startsWith('委托:')) throw new Unsupported('委托只能用 = 赋值')
    return { c: `(${target.c} ${e.op} ${value.c})`, t: target.t }
  }

  private index(e: Extract<Expr, { kind: 'index' }>): Value {
    const tgt = this.expr(e.target)
    const idx = this.expr(e.index)
    if (tgt.t === '文本') return { c: `csay_char_at(${tgt.c}, ${idx.c})`, t: '文本' }
    if (this.isArray(tgt.t)) return { c: `${tgt.c}[${idx.c}]`, t: tgt.t.slice(0, -2) }
    if (tgt.t.startsWith('列表:')) {
      const elem = tgt.t.slice(3)
      return { c: `(*(${this.cType(elem)}*)csay_list_at(${tgt.c}, ${idx.c}))`, t: elem }
    }
    if (tgt.t.startsWith('表:')) {
      const { k, v } = this.mapParts(tgt.t)
      return {
        c: this.kvBlock(k, idx.c, null, null,
          (kk) => `*(${this.cType(v)}*)csay_map_at(${tgt.c}, &${kk})`),
        t: v,
      }
    }
    throw new Unsupported('对这个值取下标')
  }

  private nullValue(t: CType): string {
    if (t === '文本') return '(CsayStr){0}'
    if (t === '异常' || t.startsWith('异常:')) return 'csay_error_null()'
    if (t.startsWith('委托:') || t.startsWith('接口:')) return `(${this.cType(t)}){ 0 }`
    return `(${this.cType(t)})0`
  }

  /** 为文本结果生成带空检查的小函数，避免 TCC 在实参里生成结构体三目表达式。 */
  private nullSafeTextHelper(selfType: CType, bodyExpr: string, label: string, params: string[] = []): string {
    const cn = this.fresh('Csay_ns_') + label
    const ps = [ `${this.cType(selfType)} self`, ...params ]
    this.lambdaProtos.push(`static CsayStr ${cn}(${ps.join(', ')});`)
    this.lambdaBodies.push(`static CsayStr ${cn}(${ps.join(', ')}) {`)
    this.lambdaBodies.push('    if (self == NULL) return (CsayStr){0};')
    this.lambdaBodies.push(`    return ${bodyExpr};`)
    this.lambdaBodies.push('}')
    this.lambdaBodies.push('')
    return cn
  }

  /** 接口引用是结构体，空检查看 obj；其余与文本辅助函数相同。 */
  private nullSafeIfaceTextHelper(selfType: CType, bodyExpr: string, label: string, params: string[] = []): string {
    const cn = this.fresh('Csay_ns_') + label
    const ps = [ `${this.cType(selfType)} self`, ...params ]
    this.lambdaProtos.push(`static CsayStr ${cn}(${ps.join(', ')});`)
    this.lambdaBodies.push(`static CsayStr ${cn}(${ps.join(', ')}) {`)
    this.lambdaBodies.push('    if (self.obj == NULL) return (CsayStr){0};')
    this.lambdaBodies.push(`    return ${bodyExpr};`)
    this.lambdaBodies.push('}')
    this.lambdaBodies.push('')
    return cn
  }

  private nullSafeMember(e: Extract<Expr, { kind: 'member' }>): Value {
    const tgt = this.expr(e.target)
    if (isErrorType(tgt.t)) {
      if (e.name === '信息') return { c: `csay_error_ns_msg(${tgt.c})`, t: '文本' }
      if (e.name === '类型') return { c: `csay_error_ns_kind(${tgt.c})`, t: '文本' }
      throw new Unsupported(`异常没有成员「${e.name}」`)
    }
    if ((tgt.t.startsWith('列表:') || tgt.t.startsWith('表:')) && (e.name === '数量' || e.name === '长度')) {
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      return { c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${tmp}->len : 0LL)`, t: '整数' }
    }
    if (this.isArray(tgt.t) && e.name === '长度') {
      if (e.target.kind === 'name' && !this.isSelfField(e.target.name)) return { c: `(${tgt.c} != NULL ? ${tgt.c}_len : 0LL)`, t: '整数' }
      return { c: `csay_array_len(${tgt.c})`, t: '整数' }
    }
    if (tgt.t.startsWith('接口:')) {
      const iface = this.types.get(tgt.t.slice(3))
      if (iface === undefined) throw new Unsupported(`接口 ${tgt.t}`)
      let slot = iface.ifaceMethods.length
      for (const p of iface.ifaceProps) {
        if (p.name === e.name && p.hasGet) {
          if (p.type === '文本') {
            const cn = this.nullSafeIfaceTextHelper(tgt.t, `self.vt->m${slot}(self.obj)`, 'ip')
            return { c: `${cn}(${tgt.c})`, t: p.type }
          }
          const tmp = this.fresh('_ns')
          this.push(`${this.cType(tgt.t)} ${tmp};`)
          return {
            c: `((${tmp} = ${tgt.c}), ${tmp}.obj != NULL ? ${tmp}.vt->m${slot}(${tmp}.obj) : ${this.nullValue(p.type)})`,
            t: p.type,
          }
        }
        if (p.hasGet) slot++
        if (p.hasSet) slot++
      }
      throw new Unsupported(`接口「${iface.name}」没有成员「${e.name}」`)
    }
    if (!this.isClass(tgt.t)) throw new Unsupported('?. 左边必须是类或接口对象')
    const owner = this.objName(tgt.t)
    const field = this.findField(owner, e.name)
    if (field !== null) {
      this.checkAccess(field.vis, field.owner, '字段', field.name)
      if (field.isConst && field.constC !== null) return { c: field.constC, t: field.type }
      const path = field.path.join('.')
      if (field.type === '文本') {
        const cn = this.nullSafeTextHelper(tgt.t, `self->${path}`, 'f')
        return { c: `${cn}(${tgt.c})`, t: field.type }
      }
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      return {
        c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${tmp}->${path} : ${this.nullValue(field.type)})`,
        t: field.type,
      }
    }
    const prop = this.findProp(owner, e.name)
    if (prop !== null) {
      if (prop.isStatic) throw new Unsupported(`静态属性「${e.name}」要通过类型名访问`)
      const propOwner = this.findPropWithOwner(owner, e.name)!
      this.checkAccess(prop.vis, propOwner.owner, '属性', prop.name)
      if (prop.getCn === null) throw new Unsupported(`属性「${e.name}」没有 取 访问器`)
      if (prop.type === '文本') {
        const cn = this.nullSafeTextHelper(tgt.t, `${prop.getCn}(self)`, 'p')
        return { c: `${cn}(${tgt.c})`, t: prop.type }
      }
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      return {
        c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${prop.getCn}(${tmp}) : ${this.nullValue(prop.type)})`,
        t: prop.type,
      }
    }
    throw new Unsupported(`成员「${e.name}」`)
  }

  private memberPath(e: Extract<Expr, { kind: 'member' }>): string | null {
    if (e.target.kind === 'name') return `${e.target.name}.${e.name}`
    if (e.target.kind === 'member') {
      const base = this.memberPath(e.target)
      return base === null ? null : `${base}.${e.name}`
    }
    return null
  }

  private member(e: Extract<Expr, { kind: 'member' }>): Value {
    if (e.nullSafe === true) return this.nullSafeMember(e)
    const path = this.memberPath(e)
    if (path !== null) {
      const dot = path.lastIndexOf('.')
      const owner = path.slice(0, dot)
      const alias = this.typeAliases.get(owner)
      if (alias !== undefined && alias.startsWith('枚举:')) {
        const info = this.types.get(alias.slice(3))
        const item = info?.enumItems.find((x) => x.name === e.name)
        if (item === undefined) throw new Unsupported(`枚举「${alias.slice(3)}」没有成员「${e.name}」`)
        return { c: item.cn, t: alias }
      }
    }
    if (e.target.kind === 'name') {
      const info = this.types.get(e.target.name)
      if (info !== undefined && info.kind === 'enum') {
        const item = info.enumItems.find((x) => x.name === e.name)
        if (item === undefined) throw new Unsupported(`枚举「${info.name}」没有成员「${e.name}」`)
        return { c: item.cn, t: `枚举:${info.name}` }
      }
      if (info !== undefined && info.kind !== 'enum' && info.kind !== 'interface') {
        const sf = this.findStaticField(info.name, e.name)
        if (sf !== null) {
          this.checkAccess(sf.vis, sf.owner, '字段', sf.name)
          if (sf.isConst && sf.constC !== null) return { c: sf.constC, t: sf.type }
          return { c: this.staticFieldCName(sf.owner, sf), t: sf.type }
        }
        const sp = this.findStaticProp(info.name, e.name)
        if (sp !== null) {
          this.checkAccess(sp.vis, sp.owner, '属性', sp.name)
          if (sp.getCn === null) throw new Unsupported(`属性「${sp.name}」没有 取 访问器`)
          return { c: `${sp.getCn}()`, t: sp.type }
        }
      }
    }

    const tgt = this.expr(e.target)
    const name = e.name

    // 接口引用：只能访问接口里声明的方法与属性，走虚表
    if (tgt.t.startsWith('接口:')) {
      const iface = this.types.get(tgt.t.slice(3))
      if (iface === undefined) throw new Unsupported(`接口 ${tgt.t}`)
      let slot = iface.ifaceMethods.length
      for (const p of iface.ifaceProps) {
        if (p.hasGet) {
          if (p.name === name) return { c: `${tgt.c}.vt->m${slot}(${tgt.c}.obj)`, t: p.type }
          slot++
        } else if (p.name === name) {
          throw new Unsupported(`属性「${name}」没有 取 访问器`)
        }
        if (p.hasSet) slot++
      }
      throw new Unsupported(`接口「${iface.name}」没有成员「${name}」`)
    }

    if (this.isObj(tgt.t)) {
      const owner = this.objName(tgt.t)
      const field = this.findField(owner, name)
      if (field !== null) {
        this.checkAccess(field.vis, field.owner, '字段', field.name)
        if (field.isConst && field.constC !== null) return { c: field.constC, t: field.type }
        const path = field.path.join('.')
        const code = this.isClass(tgt.t) ? `${this.objPtr(tgt)}->${path}` : e.target.kind === 'this' ? `self->${path}` : `${tgt.c}.${path}`
        return { c: code, t: field.type }
      }
      const prop = this.findProp(owner, name)
      if (prop !== null) {
        if (prop.isStatic) throw new Unsupported(`静态属性「${name}」要通过类型名访问`)
        const propOwner = this.findPropWithOwner(owner, name)!; this.checkAccess(prop.vis, propOwner.owner, '属性', prop.name)
        if (prop.getCn === null) throw new Unsupported(`属性「${name}」没有 取 访问器`)
        return { c: `${prop.getCn}(${this.objPtr(tgt)})`, t: prop.type }
      }
      throw new Unsupported(`成员「${name}」`)
    }

    if (tgt.t.startsWith('条目:')) {
      const [, k, v] = tgt.t.split(':')
      if (name === '键') return { c: `${tgt.c}.key`, t: k }
      if (name === '值') return { c: `${tgt.c}.val`, t: v }
      throw new Unsupported(`条目的成员「${name}」`)
    }
    if (isErrorType(tgt.t)) {
      if (name === '信息') return { c: `${tgt.c}.msg`, t: '文本' }
      if (name === '类型') return { c: `csay_error_kind_name(${tgt.c}.kind)`, t: '文本' }
      throw new Unsupported(`异常的成员「${name}」`)
    }
    if (tgt.t.startsWith('列表:') && (name === '数量' || name === '长度')) return { c: `${tgt.c}->len`, t: '整数' }
    if (tgt.t.startsWith('表:') && name === '数量') return { c: `${tgt.c}->len`, t: '整数' }
    if (this.isArray(tgt.t) && name === '长度') {
      if (e.target.kind === 'name' && !this.isSelfField(e.target.name)) return { c: `${tgt.c}_len`, t: '整数' }
      return { c: `csay_array_len(${tgt.c})`, t: '整数' }
    }
    if (tgt.t === '文本' && name === '长度') return { c: `csay_utf8_len(${tgt.c})`, t: '整数' }

    throw new Unsupported(`成员访问「${name}」`)
  }

  private newObject(e: Extract<Expr, { kind: 'new' }>): Value {
    const t = this.resolveType(e.type)
    if (t.startsWith('列表:')) {
      const elem = t.slice(3)
      return { c: `csay_list_new((int64_t)sizeof(${this.cType(elem)}))`, t }
    }
    if (t.startsWith('表:')) {
      const { k, v } = this.mapParts(t)
      const hashFn = k === '文本' ? 'csay_hash_str' : k === '真假' ? 'csay_hash_bool' : 'csay_hash_int'
      const eqFn = k === '文本' ? 'csay_eq_str' : k === '真假' ? 'csay_eq_bool' : 'csay_eq_int'
      return {
        c: `csay_map_new((int64_t)sizeof(${this.cType(k)}), (int64_t)sizeof(${this.cType(v)}), ${hashFn}, ${eqFn})`,
        t,
      }
    }
    if (!this.isObj(t)) throw new Unsupported(`新 ${t}`)
    const info = this.typeInfo(t)
    if (info.isAbstract) throw new Unsupported(`抽象类「${info.name}」不能实例化`)
    let ctor: CtorInfo | undefined
    let ordered: Expr[] = []
    for (const c of info.ctors) {
      const r = arrangeArguments(e.args, c.raw.params.map((p: Param) => p.name), c.defaults)
      if (r.error !== undefined) continue
      if (r.args.length < c.minArgs || r.args.length > c.params.length) continue
      ctor = c
      ordered = r.args
      break
    }
    if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
    this.checkCtorAccess(ctor, info.name)
    const args = this.callArgsWithDefaults(ordered, ctor.params, ctor.defaults, ctor.modes, true)
    return { c: `${ctor.cn}(${args.join(', ')})`, t }
  }

  private delegateCall(t: CType, recv: string, args: Expr[]): Value {
    const d = this.delegates.get(t.slice(3))
    if (d === undefined) throw new Unsupported(`委托 ${t}`)
    args = this.orderedArgs(args, d.paramNames, [], `委托「${d.name}」`)
    if (args.length !== d.params.length) throw new Unsupported(`委托「${d.name}」需要 ${d.params.length} 个参数`)
    const vals = args.map((a, i) => this.coerce(this.expr(a), d.params[i]))
    const tmp = this.fresh('dg')
    const fn = `${tmp}.fn(${[`${tmp}.env`, ...vals].join(', ')})`
    return {
      c: `({ ${this.cType(t)} ${tmp} = ${recv}; if (${tmp}.fn == NULL) csay_throw_error(csay_error(${strLit('委托为空')}, 2)); ${fn}; })`,
      t: d.ret,
    }
  }

  private nullSafeCall(e: Extract<Expr, { kind: 'call' }>): Value {
    const member = e.callee as Extract<Expr, { kind: 'member' }>
    const tgt = this.expr(member.target)
    if (tgt.t.startsWith('接口:')) {
      const iface = this.types.get(tgt.t.slice(3))
      if (iface === undefined) throw new Unsupported(`接口 ${tgt.t}`)
      const slot = iface.ifaceMethods.findIndex((x) => x.name === member.name)
      if (slot < 0) throw new Unsupported(`方法「${member.name}」`)
      const m = iface.ifaceMethods[slot]
      const args = this.callArgsWithDefaults(this.orderedArgs(e.args, m.paramNames, m.defaults, `方法「${m.name}」`), m.params, m.defaults, m.modes)
      if (m.ret === '文本') {
        const ps = this.methodParamTypes(m).map((p, i) => `${p} p${i}`)
        const ns = ['self.obj', ...m.params.map((_, i) => `p${i}`)].join(', ')
        const cn = this.nullSafeIfaceTextHelper(tgt.t, `self.vt->m${slot}(${ns})`, 'im', ps)
        return { c: `${cn}(${[tgt.c, ...args].join(', ')})`, t: m.ret }
      }
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      return {
        c: `((${tmp} = ${tgt.c}), ${tmp}.obj != NULL ? ${tmp}.vt->m${slot}(${[tmp + '.obj', ...args].join(', ')}) : ${this.nullValue(m.ret)})`,
        t: m.ret,
      }
    }
    if (tgt.t.startsWith('列表:')) {
      const elem = tgt.t.slice(3)
      if (member.name !== '最大' && member.name !== '最小') throw new Unsupported(`?. 列表只支持 最大/最小`)
      const suffix = elem === '整数' ? 'int' : elem === '浮点数' ? 'float32' : elem === '长小数' ? 'float' : null
      if (suffix === null) throw new Unsupported(`?. 列表${member.name}（元素类型 ${elem}）`)
      const fn = `csay_list_${member.name === '最大' ? 'max' : 'min'}_${suffix}`
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      return { c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${fn}(${tmp}) : 0)`, t: elem }
    }
    if (tgt.t.startsWith('表:')) {
      const { k, v } = this.mapParts(tgt.t)
      if (member.name === '取值') {
        const key = this.expr(e.args[0])
        const def = this.expr(e.args[1])
        const tmp = this.fresh('_ns')
        this.push(`${this.cType(tgt.t)} ${tmp};`)
        if (v === '文本') {
          const call = this.kvBlock(k, key.c, '文本', def.c, (kk, vv) => `csay_map_text_or(${tmp}, &${kk}, ${vv})`)
          return { c: `((${tmp} = ${tgt.c}), ${call})`, t: v }
        }
        if (v !== '整数' && v !== '浮点数' && v !== '长小数' && v !== '真假' && !v.startsWith('列表:') && !v.startsWith('表:') && !v.endsWith('[]')) {
          throw new Unsupported(`?. 表取值不支持值类型 ${v}`)
        }
        const call = this.kvBlock(k, key.c, v, def.c, (kk, vv) => `*(${this.cType(v)}*)csay_map_ptr_or(${tmp}, &${kk}, &${vv})`)
        return { c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${call} : ${def.c})`, t: v }
      }
      if (member.name !== '含') throw new Unsupported(`?. 表只支持 含/取值`)
      const key = this.expr(e.args[0])
      const tmp = this.fresh('_ns')
      this.push(`${this.cType(tgt.t)} ${tmp};`)
      const call = this.kvBlock(k, key.c, null, null, (kk) => `csay_map_has(${tmp}, &${kk})`)
      return { c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${call} : false)`, t: '真假' }
    }
    if (!this.isClass(tgt.t)) throw new Unsupported('?. 左边必须是类、接口或列表对象')
    const owner = this.objName(tgt.t)
    const list = this.findMethodsWithOwner(owner, member.name)
    const found = list.length > 1 ? list[member.overload ?? 0] : list[0]
    if (found === undefined) throw new Unsupported(`方法「${member.name}」`)
    const m = found.method
    if (m.isStatic) throw new Unsupported(`?. 不能调用静态方法「${member.name}」`)
    this.checkAccess(m.vis, found.owner, '方法', m.name)
    const args = this.callArgsWithDefaults(this.orderedRaw(e.args, m.raw.params, m.defaults, `方法「${m.name}」`), m.params, m.defaults, m.modes)
    const mods = m.raw.modifiers as string[]
    const dispatch = mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象')
    if (m.ret === '文本') {
      const ps = this.methodParamTypes(m).map((p, i) => `${p} p${i}`)
      const ns = ['self', ...m.params.map((_, i) => `p${i}`)].join(', ')
      const call = dispatch ? `Csay_dispatch_${member.name}(${ns})` : `${m.cn}(${ns})`
      const cn = this.nullSafeTextHelper(tgt.t, call, 'm', ps)
      return { c: `${cn}(${[tgt.c, ...args].join(', ')})`, t: m.ret }
    }
    const tmp = this.fresh('_ns')
    this.push(`${this.cType(tgt.t)} ${tmp};`)
    const call = dispatch
      ? `Csay_dispatch_${member.name}(${[tmp, ...args].join(', ')})`
      : `${m.cn}(${[tmp, ...args].join(', ')})`
    return {
      c: `((${tmp} = ${tgt.c}), ${tmp} != NULL ? ${call} : ${this.nullValue(m.ret)})`,
      t: m.ret,
    }
  }

  private call(e: Extract<Expr, { kind: 'call' }>): Value {
    if (e.callee.kind === 'member' && e.callee.nullSafe === true) return this.nullSafeCall(e)
    if (e.callee.kind === 'name') {
      const t = this.lookup(e.callee.name)
      if (t !== undefined && t.startsWith('委托:')) {
        return this.delegateCall(t, this.cname(e.callee.name), e.args)
      }
    }
    if (e.callee.kind === 'member' && e.callee.target.kind === 'name') {
      const info = this.types.get(e.callee.target.name)
      if (info !== undefined && (info.kind === 'class' || info.kind === 'struct')) {
        const list = this.findMethodsWithOwner(info.name, e.callee.name)
        const found = list.length > 1 ? list[e.overload ?? 0] : list[0]
        const m = found?.method ?? null
        if (m !== null) {
          if (!m.isStatic) throw new Unsupported(`方法「${e.callee.name}」不是静态方法`)
          this.checkAccess(m.vis, info.name, '方法', m.name)
          const args = this.orderedRaw(e.args, m.raw.params, m.defaults, `方法「${m.name}」`)
          return { c: `${m.cn}(${this.callArgsWithDefaults(args, m.params, m.defaults, m.modes).join(', ')})`, t: m.ret }
        }
      }
    }
    if (e.callee.kind === 'member') {
      const recv = this.expr(e.callee.target)
      const name = e.callee.name

      if (recv.t.startsWith('委托:')) return this.delegateCall(recv.t, recv.c, e.args)

      if (this.isObj(recv.t)) {
        const df = this.findField(this.objName(recv.t), name)
        if (df !== null && df.type.startsWith('委托:')) {
          return this.delegateCall(df.type, this.member(e.callee).c, e.args)
        }
      }

      // 接口方法：查槽位，走虚表分派
      if (recv.t.startsWith('接口:')) {
        const iface = this.types.get(recv.t.slice(3))
        if (iface === undefined) throw new Unsupported(`接口 ${recv.t}`)
        const idx = iface.ifaceMethods.findIndex((m) => m.name === name)
        if (idx < 0) throw new Unsupported(`接口「${iface.name}」没有方法「${name}」`)
        const m = iface.ifaceMethods[idx]
        const args = this.callArgsWithDefaults(this.orderedArgs(e.args, m.paramNames, m.defaults, `接口方法「${name}」`), m.params, m.defaults, m.modes)
        return {
          c: `${recv.c}.vt->m${idx}(${[`${recv.c}.obj`, ...args].join(', ')})`,
          t: m.ret,
        }
      }

      if (this.isObj(recv.t)) {
        const list = this.findMethodsWithOwner(this.objName(recv.t), name)
        const found = list.length > 1 ? list[e.overload ?? 0] : list[0]
        if (found === undefined) throw new Unsupported(`方法「${name}」`)
        const m = found.method
        this.checkAccess(m.vis, found.owner, '方法', m.name)
        const args = this.callArgsWithDefaults(this.orderedRaw(e.args, m.raw.params, m.defaults, `方法「${m.name}」`), m.params, m.defaults, m.modes)
        if (m.isStatic) return { c: `${m.cn}(${args.join(', ')})`, t: m.ret }
        const mods = m.raw.modifiers as string[]
        if (e.callee.target.kind === 'base' && mods.includes('抽象')) {
          throw new Unsupported(`不能通过「基」调用抽象方法「${name}」`)
        }
        if (e.callee.target.kind !== 'base' && (mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象'))) {
          return { c: `Csay_dispatch_${name}(${[this.objPtr(recv), ...args].join(', ')})`, t: m.ret }
        }
        return { c: `${m.cn}(${[this.objPtr(recv), ...args].join(', ')})`, t: m.ret }
      }

      if (this.isArray(recv.t)) {
        const elem = recv.t.slice(0, -2)
        const field = this.isArrayField(e.callee.target)
        if (!field && e.callee.target.kind !== 'name') throw new Unsupported('数组添加、删除、插入只支持数组变量或字段')
        const arr = recv.c
        const elemC = this.cType(elem)
        const slot = field ? this.fresh('slot') : null
        const arrLen = field ? this.fresh('len') : `${recv.c}_len`
        const prelude = field
          ? `${this.cType(recv.t)}* ${slot} = &(${arr}); CsayInt ${arrLen} = csay_array_len(*${slot});`
          : ''
        const arrPtr = field ? `(void**)${slot}` : `(void**)&${arr}`
        if (name === '添加') {
          const v = this.expr(e.args[0])
          const x = this.fresh('v')
          return {
            c: `({ ${this.cType(elem)} ${x} = ${v.c}; ${prelude} csay_array_append(${arrPtr}, &${arrLen}, sizeof(${elemC}), &${x}); 0LL; })`,
            t: '无',
          }
        }
        if (name === '删除') {
          const at = this.expr(e.args[0])
          const i = this.fresh('i')
          return {
            c: `({ CsayInt ${i} = ${at.c}; ${prelude} csay_array_remove(${arrPtr}, &${arrLen}, sizeof(${elemC}), ${i}); 0LL; })`,
            t: '无',
          }
        }
        if (name === '插入') {
          const at = this.expr(e.args[0])
          const v = this.expr(e.args[1])
          const i = this.fresh('i')
          const x = this.fresh('v')
          return {
            c: `({ CsayInt ${i} = ${at.c}; ${this.cType(elem)} ${x} = ${v.c}; ${prelude} csay_array_insert(${arrPtr}, &${arrLen}, sizeof(${elemC}), ${i}, &${x}); 0LL; })`,
            t: '无',
          }
        }
        throw new Unsupported(`数组的方法「${name}」`)
      }

      if (recv.t.startsWith('列表:')) {
        const elem = recv.t.slice(3)
        if (name === '追加') {
          return {
            c: this.withTemp(elem, this.expr(e.args[0]).c,
              (v) => `(csay_list_add(${recv.c}, &${v}), 0LL)`),
            t: '无',
          }
        }
        if (name === '插入') {
          const at = this.expr(e.args[0])
          return {
            c: this.withTemp(elem, this.expr(e.args[1]).c,
              (v) => `(csay_list_insert(${recv.c}, ${at.c}, &${v}), 0LL)`),
            t: '无',
          }
        }
        if (name === '删除') {
          return { c: `(csay_list_remove(${recv.c}, ${this.expr(e.args[0]).c}), 0LL)`, t: '无' }
        }
        if (name === '清空') {
          return { c: `(csay_list_clear(${recv.c}), 0LL)`, t: '无' }
        }
        if (name === '含') {
          const v = this.expr(e.args[0])
          const fn = elem === '整数'
            ? 'csay_list_index_int'
            : elem === '浮点数'
              ? 'csay_list_index_float32'
              : elem === '长小数'
                ? 'csay_list_index_float'
                : elem === '文本'
                  ? 'csay_list_index_str'
                  : null
          if (fn === null) throw new Unsupported(`列表包含（元素类型 ${elem}）`)
          return { c: `${fn}(${recv.c}, ${v.c}) >= 0`, t: '真假' }
        }
        if (name === '查找') {
          const v = this.expr(e.args[0])
          const fn = elem === '整数'
            ? `csay_list_index_int(${recv.c}, ${v.c})`
            : elem === '浮点数'
              ? `csay_list_index_float32(${recv.c}, ${v.c})`
              : elem === '长小数'
                ? `csay_list_index_float(${recv.c}, ${v.c})`
                : elem === '文本'
                  ? `csay_list_index_str(${recv.c}, ${v.c})`
                  : null
          if (fn === null) throw new Unsupported(`列表查找（元素类型 ${elem}）`)
          return { c: fn, t: '整数' }
        }
        if (name === '排序') {
          const fn = elem === '整数'
            ? 'csay_cmp_int'
            : elem === '浮点数'
              ? 'csay_cmp_float32'
              : elem === '长小数'
                ? 'csay_cmp_float'
                : elem === '文本'
                  ? 'csay_cmp_str'
                  : null
          if (fn === null) throw new Unsupported(`列表排序（元素类型 ${elem}）`)
          return { c: `(csay_list_sort(${recv.c}, ${fn}), 0LL)`, t: '无' }
        }
        if (name === '最大' || name === '最小') {
          const suffix = elem === '整数'
            ? 'int'
            : elem === '浮点数'
              ? 'float32'
              : elem === '长小数'
                ? 'float'
                : elem === '文本'
                  ? 'str'
                  : null
          if (suffix === null) throw new Unsupported(`列表的${name}值（元素类型 ${elem}）`)
          const fn = `csay_list_${name === '最大' ? 'max' : 'min'}_${suffix}`
          return { c: `${fn}(${recv.c})`, t: elem }
        }
        if (name === '反转') {
          return { c: `(csay_list_reverse(${recv.c}), 0LL)`, t: '无' }
        }
        if (name === '切片') {
          const from = this.expr(e.args[0])
          const to = this.expr(e.args[1])
          return { c: `csay_list_slice(${recv.c}, ${from.c}, ${to.c})`, t: recv.t }
        }
        if (name === '去重') {
          const fn = elem === '整数'
            ? 'csay_list_unique_int'
            : elem === '浮点数'
              ? 'csay_list_unique_float32'
              : elem === '长小数'
                ? 'csay_list_unique_float'
                : elem === '文本'
                  ? 'csay_list_unique_str'
                  : null
          if (fn === null) throw new Unsupported(`列表去重（元素类型 ${elem}）`)
          return { c: `(${fn}(${recv.c}), 0LL)`, t: '无' }
        }
        const simple = elem === '整数'
          ? 'int'
          : elem === '浮点数'
            ? 'float32'
            : elem === '长小数'
              ? 'float'
              : elem === '文本'
                ? 'str'
                : elem === '真假'
                  ? 'bool'
                  : null
        if (name === '集合添加') {
          if (simple === null) throw new Unsupported(`集合添加（元素类型 ${elem}）`)
          const v = this.expr(e.args[0])
          return { c: `csay_list_add_unique_${simple}(${recv.c}, ${v.c})`, t: '真假' }
        }
        if (name === '入队' || name === '入栈') {
          const v = this.expr(e.args[0])
          return {
            c: this.withTemp(elem, v.c, (x) => `(csay_list_add(${recv.c}, &${x}), 0LL)`),
            t: '无',
          }
        }
        if (name === '出队' || name === '出栈') {
          if (simple === null) throw new Unsupported(`${name}（元素类型 ${elem}）`)
          const side = name === '出队' ? 'front' : 'back'
          return { c: `csay_list_pop_${side}_${simple}(${recv.c})`, t: elem }
        }
        throw new Unsupported(`列表的方法「${name}」`)
      }

      if (recv.t.startsWith('表:')) {
        const { k, v } = this.mapParts(recv.t)
        if (name === '含') {
          return {
            c: this.kvBlock(k, this.expr(e.args[0]).c, null, null,
              (kk) => `csay_map_has(${recv.c}, &${kk})`),
            t: '真假',
          }
        }
        if (name === '取值') {
          return {
            c: this.kvBlock(k, this.expr(e.args[0]).c, v, this.expr(e.args[1]).c,
              (kk, vv) => `*(${this.cType(v)}*)csay_map_ptr_or(${recv.c}, &${kk}, &${vv})`),
            t: v,
          }
        }
        if (name === '条目') {
          return { c: `csay_map_entries_${k}_${v}(${recv.c})`, t: `列表:条目:${k}:${v}` }
        }
        if (name === '设置') {
          return {
            c: this.kvBlock(k, this.expr(e.args[0]).c, v, this.expr(e.args[1]).c,
              (kk, vv) => `(csay_map_set(${recv.c}, &${kk}, &${vv}), 0LL)`),
            t: '无',
          }
        }
        if (name === '删除') {
          return {
            c: this.kvBlock(k, this.expr(e.args[0]).c, null, null,
              (kk) => `(csay_map_remove(${recv.c}, &${kk}), 0LL)`),
            t: '无',
          }
        }
        throw new Unsupported(`表的方法「${name}」`)
      }

      if (recv.t === '文本') {
        if (name === '切分') return { c: `csay_split(${recv.c}, ${this.expr(e.args[0]).c})`, t: '列表:文本' }
        if (name === '切分空白') return { c: `csay_split_ws(${recv.c})`, t: '列表:文本' }
        if (name === '替换') {
          return {
            c: `csay_str_replace(${recv.c}, ${this.expr(e.args[0]).c}, ${this.expr(e.args[1]).c})`,
            t: '文本',
          }
        }
        if (name === '含') return { c: `csay_str_contains(${recv.c}, ${this.expr(e.args[0]).c})`, t: '真假' }
        if (name === '转大写') return { c: `csay_str_upper(${recv.c})`, t: '文本' }
        if (name === '转小写') return { c: `csay_str_lower(${recv.c})`, t: '文本' }
        if (name === '去除空白') return { c: `csay_str_trim(${recv.c})`, t: '文本' }
        if (name === '转整数') return { c: `csay_str_to_int(${recv.c})`, t: '整数' }
        if (name === '转长小数') return { c: `csay_str_to_float(${recv.c})`, t: '长小数' }
        if (name === '转浮点数') return { c: `csay_str_to_float32(${recv.c})`, t: '浮点数' }
        throw new Unsupported(`文本的方法「${name}」`)
      }
      throw new Unsupported(`这个类型的方法「${name}」`)
    }

    if (e.callee.kind !== 'name') throw new Unsupported('把表达式当函数调用')
    const name = e.callee.name

    if (name === '打印') throw new Unsupported('打印 只能作为语句使用')
    if (name === '回收') return { c: '(csay_gc_collect(), 0LL)', t: '无' }
    if (name === '内存块数') return { c: 'csay_gc_block_count', t: '整数' }
    if (name === '内存字节数') return { c: 'csay_gc_bytes', t: '整数' }
    if (name === '退出') {
      const a = e.args[0] === undefined ? { c: '0', t: '整数' } : this.expr(e.args[0])
      return { c: `(csay_exit(${a.c}), 0LL)`, t: '无' }
    }
    if (name === '读文件') return { c: `csay_read_file(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '当前时间') return { c: 'csay_now()', t: '文本' }
    if (name === '当前日期') return { c: 'csay_today()', t: '文本' }
    if (name === '时间戳') return { c: 'csay_timestamp()', t: '整数' }
    if (name === '解析时间') return { c: `csay_parse_time(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '格式化时间') {
      const seconds = this.expr(e.args[0]).c
      const format = this.expr(e.args[1]).c
      if (e.args.length >= 3) {
        return { c: `csay_format_time_zone(${seconds}, ${format}, ${this.expr(e.args[2]).c})`, t: '文本' }
      }
      return { c: `csay_format_time(${seconds}, ${format})`, t: '文本' }
    }
    if (name === '本地化时间') {
      return { c: `csay_localized_time(${this.expr(e.args[0]).c}, ${this.expr(e.args[1]).c})`, t: '文本' }
    }
    if (name === '当前目录') return { c: 'csay_current_dir()', t: '文本' }
    if (name === '路径合并') {
      return { c: `csay_path_join(${this.expr(e.args[0]).c}, ${this.expr(e.args[1]).c})`, t: '文本' }
    }
    if (name === '路径存在') return { c: `csay_path_exists(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '目录列表') return { c: `csay_list_dir(${this.expr(e.args[0]).c})`, t: '列表:文本' }
    if (name === '创建目录') return { c: `csay_make_dir(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '删除文件') return { c: `csay_remove_file(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '删除目录') return { c: `csay_remove_dir(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '是目录') return { c: `csay_is_dir(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '是文件') return { c: `csay_is_file(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '文件大小') return { c: `csay_file_size(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '读环境变量') return { c: `csay_getenv(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '系统平台') return { c: 'csay_platform()', t: '文本' }
    if (name === '运行命令') return { c: `csay_run_command(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '运行命令输出') return { c: `csay_run_capture(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '打开文件') {
      const p = this.expr(e.args[0])
      const m = this.expr(e.args[1])
      return { c: `csay_file_open(${p.c}, ${m.c})`, t: '整数' }
    }
    if (name === '读文件行') return { c: `csay_file_read_line(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '写文件行') {
      const h = this.expr(e.args[0])
      const t = this.expr(e.args[1])
      return { c: `csay_file_write_line(${h.c}, ${t.c})`, t: '真假' }
    }
    if (name === '文件末尾') return { c: `csay_file_eof(${this.expr(e.args[0]).c})`, t: '真假' }
    if (name === '关闭文件') {
      const h = this.expr(e.args[0])
      return { c: `(csay_file_close(${h.c}), 0LL)`, t: '无' }
    }
    if (name === '命令行参数') return { c: 'csay_args()', t: '列表:文本' }
    if (name === '断言') {
      const cond = this.expr(e.args[0])
      if (cond.t !== '真假') throw new Unsupported('断言() 的第一个参数必须是真假')
      const msg = e.args[1] === undefined ? null : this.expr(e.args[1])
      if (msg !== null && msg.t !== '文本') throw new Unsupported('断言() 的消息必须是文本')
      return { c: `(csay_assert(${cond.c}, ${msg === null ? 'csay_lit("")' : msg.c}), 0LL)`, t: '无' }
    }
    if (name === '开方') return { c: `sqrt((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '正弦') return { c: `sin((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '余弦') return { c: `cos((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '正切') return { c: `tan((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '反正弦') return { c: `asin((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '反余弦') return { c: `acos((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '反正切') return { c: `atan((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '反正切2') {
      const y = this.expr(e.args[0])
      const x = this.expr(e.args[1])
      return { c: `atan2((double)(${y.c}), (double)(${x.c}))`, t: '长小数' }
    }
    if (name === '自然对数') return { c: `log((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '常用对数') return { c: `log10((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '指数') return { c: `exp((double)(${this.expr(e.args[0]).c}))`, t: '长小数' }
    if (name === '幂') {
      const a = this.expr(e.args[0])
      const b = this.expr(e.args[1])
      return { c: `pow((double)(${a.c}), (double)(${b.c}))`, t: '长小数' }
    }
    if (name === '向下取整') return { c: `(int64_t)floor((double)(${this.expr(e.args[0]).c}))`, t: '整数' }
    if (name === '向上取整') return { c: `(int64_t)ceil((double)(${this.expr(e.args[0]).c}))`, t: '整数' }
    if (name === '截断') return { c: `(int64_t)trunc((double)(${this.expr(e.args[0]).c}))`, t: '整数' }
    if (name === '符号') {
      const a = this.expr(e.args[0])
      return { c: `((${a.c}) > 0 ? 1LL : ((${a.c}) < 0 ? -1LL : 0LL))`, t: '整数' }
    }
    if (name === '最大' || name === '最小') {
      const a = this.expr(e.args[0])
      const b = this.expr(e.args[1])
      const rt = a.t === '长小数' || b.t === '长小数'
        ? '长小数'
        : a.t === '浮点数' || b.t === '浮点数'
          ? '浮点数'
          : '整数'
      const op = name === '最大' ? '>' : '<'
      return { c: `((${a.c}) ${op} (${b.c}) ? (${a.c}) : (${b.c}))`, t: rt }
    }
    if (name === '圆周率') return { c: '3.14159265358979323846', t: '长小数' }
    if (name === '随机') return { c: 'csay_random()', t: '长小数' }
    if (name === '随机整数') {
      const a = this.expr(e.args[0])
      const b = this.expr(e.args[1])
      return { c: `csay_random_int(${a.c}, ${b.c})`, t: '整数' }
    }
    if (name === '随机种子') {
      const a = this.expr(e.args[0])
      return { c: `(csay_random_seed(${a.c}), 0LL)`, t: '无' }
    }
    if (name === '文本长度') return { c: `csay_utf8_len(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '转大写') return { c: `csay_str_upper(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '转小写') return { c: `csay_str_lower(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '去除空白') return { c: `csay_str_trim(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '重复文本') {
      const s = this.expr(e.args[0])
      const n = this.expr(e.args[1])
      return { c: `csay_repeat(${s.c}, ${n.c})`, t: '文本' }
    }
    if (name === '连接文本') {
      const l = this.expr(e.args[0])
      if (l.t !== '列表:文本') throw new Unsupported('连接文本() 的第一个参数必须是 列表<文本>')
      const sep = this.expr(e.args[1])
      return { c: `csay_join(${l.c}, ${sep.c})`, t: '文本' }
    }
    if (name === '格式化浮点') {
      const v = this.expr(e.args[0])
      const d = this.expr(e.args[1])
      return { c: `csay_format_float((CsayFloat)(${v.c}), ${d.c})`, t: '文本' }
    }
    if (name === '格式化') {
      const f = this.expr(e.args[0])
      const l = this.expr(e.args[1])
      if (l.t !== '列表:文本') throw new Unsupported('格式化() 的第二个参数必须是 列表<文本>')
      return { c: `csay_format_text(${f.c}, ${l.c})`, t: '文本' }
    }
    if (name === '填充文本') {
      const s = this.expr(e.args[0])
      const w = this.expr(e.args[1])
      const f = this.expr(e.args[2])
      return { c: `csay_fill_text(${s.c}, ${w.c}, ${f.c})`, t: '文本' }
    }
    if (name === '查找文本') {
      const s = this.expr(e.args[0])
      const sub = this.expr(e.args[1])
      return { c: `csay_find_text(${s.c}, ${sub.c})`, t: '整数' }
    }
    if (name === '正则匹配') {
      const s = this.expr(e.args[0])
      const p = this.expr(e.args[1])
      return { c: `csay_regex_match(${s.c}, ${p.c})`, t: '真假' }
    }
    if (name === '正则查找') {
      const s = this.expr(e.args[0])
      const p = this.expr(e.args[1])
      return { c: `csay_regex_find(${s.c}, ${p.c})`, t: '整数' }
    }
    if (name === '正则替换') {
      const s = this.expr(e.args[0])
      const p = this.expr(e.args[1])
      const r = this.expr(e.args[2])
      return { c: `csay_regex_replace(${s.c}, ${p.c}, ${r.c})`, t: '文本' }
    }
    if (name === 'JSON字符串') return { c: `csay_json_text(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === 'JSON解析') {
      const s = this.expr(e.args[0])
      if (s.t !== '文本') throw new Unsupported('JSON解析() 的参数必须是文本')
      return { c: `csay_json_parse(${s.c})`, t: '表:文本:文本' }
    }
    if (name === 'JSON取值') {
      const s = this.expr(e.args[0])
      const p = this.expr(e.args[1])
      if (s.t !== '文本' || p.t !== '文本') throw new Unsupported('JSON取值() 的两个参数都必须是文本')
      return { c: `csay_json_get(${s.c}, ${p.c})`, t: '文本' }
    }
    if (name === 'JSON设置') {
      const s = this.expr(e.args[0])
      const p = this.expr(e.args[1])
      const v = this.expr(e.args[2])
      if (s.t !== '文本' || p.t !== '文本' || v.t !== '文本') throw new Unsupported('JSON设置() 的三个参数都必须是文本')
      return { c: `csay_json_set(${s.c}, ${p.c}, ${v.c})`, t: '文本' }
    }
    if (name === 'JSON序列化') {
      const v = this.expr(e.args[0])
      if (v.t === '文本') return { c: `csay_json_text(${v.c})`, t: '文本' }
      if (v.t === '字符') return { c: `csay_json_text(csay_char_of_code(${v.c}))`, t: '文本' }
      if (isIntegerType(v.t)) return { c: `csay_str_of_int(${v.c})`, t: '文本' }
      if (v.t === '浮点数') return { c: `csay_str_of_float32(${v.c})`, t: '文本' }
      if (v.t === '长小数') return { c: `csay_str_of_float(${v.c})`, t: '文本' }
      if (v.t === '真假') return { c: `csay_json_bool(${v.c})`, t: '文本' }
      if (v.t.endsWith('[]')) {
        const base = v.t.slice(0, -2)
        const simple = e.args[0].kind === 'name'
        if (base === '字符' && simple) return { c: `csay_json_any(${v.c}, ${v.c}_len, (int64_t)sizeof(*${v.c}), "ac")`, t: '文本' }
        const kind = base === '文本' ? 0 : isIntegerType(base) ? 1 : base === '长小数' ? 2 : base === '真假' ? 3 : base === '浮点数' ? 4 : -1
        if (kind >= 0 && simple) return { c: `csay_json_array(${v.c}, ${v.c}_len, ${kind})`, t: '文本' }
      }
      if (v.t === '列表:文本') return { c: `csay_json_list(${v.c}, 0)`, t: '文本' }
      if (v.t === '列表:字符') return { c: this.withTemp(v.t, v.c, (x) => `csay_json_any(&${x}, 0, 0, "lc")`), t: '文本' }
      if (v.t.startsWith('列表:') && isIntegerType(v.t.slice(3))) return { c: `csay_json_list(${v.c}, 1)`, t: '文本' }
      if (v.t === '列表:浮点数') return { c: `csay_json_list(${v.c}, 4)`, t: '文本' }
      if (v.t === '列表:长小数') return { c: `csay_json_list(${v.c}, 2)`, t: '文本' }
      if (v.t === '列表:真假') return { c: `csay_json_list(${v.c}, 3)`, t: '文本' }
      if (v.t === '表:文本:文本') return { c: `csay_json_map(${v.c}, 0)`, t: '文本' }
      if (v.t === '表:文本:字符') return { c: this.withTemp(v.t, v.c, (x) => `csay_json_any(&${x}, 0, 0, "msc")`), t: '文本' }
      if (v.t.startsWith('表:文本:') && isIntegerType(v.t.slice(5))) return { c: `csay_json_map(${v.c}, 1)`, t: '文本' }
      if (v.t === '表:文本:长小数') return { c: `csay_json_map(${v.c}, 2)`, t: '文本' }
      if (v.t === '表:文本:真假') return { c: `csay_json_map(${v.c}, 3)`, t: '文本' }
      if (v.t === '表:文本:浮点数') return { c: `csay_json_map(${v.c}, 4)`, t: '文本' }
      const desc = this.jsonDesc(v.t)
      if (desc !== null) {
        return { c: this.withTemp(v.t, v.c, (x) => `csay_json_any(&${x}, 0, 0, "${desc}")`), t: '文本' }
      }
      throw new Unsupported(`JSON序列化() 暂不支持「${v.t}」`)
    }
    if (name === '字符') return { c: `csay_char_of_code(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '移出区域') {
      const a = this.expr(e.args[0])
      if (a.t !== '文本') throw new Unsupported('移出区域() 目前只支持文本')
      return { c: `csay_keep_str(${a.c})`, t: '文本' }
    }
    if (name === '输入') return { c: 'csay_read_line()', t: '文本' }
    if (name === '询问') return { c: 'csay_ask(' + this.expr(e.args[0]).c + ')', t: '文本' }
    if (name === '转整数') return { c: 'csay_str_to_int(' + this.expr(e.args[0]).c + ')', t: '整数' }
    if (name === '转长小数') return { c: 'csay_str_to_float(' + this.expr(e.args[0]).c + ')', t: '长小数' }
    if (name === '转浮点数') return { c: 'csay_str_to_float32(' + this.expr(e.args[0]).c + ')', t: '浮点数' }
    if (name === '四舍五入') return { c: `csay_round(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '绝对值') {
      const a = this.expr(e.args[0])
      if (a.t === '浮点数') return { c: `fabsf(${a.c})`, t: '浮点数' }
      return { c: `fabs((double)(${a.c}))`, t: '长小数' }
    }
    if (name === '写文件') {
      const p = this.expr(e.args[0])
      const c = this.expr(e.args[1])
      return { c: `csay_write_file(${p.c}, ${c.c})`, t: '真假' }
    }
    if (ERROR_KINDS[name] !== undefined) {
      const msg = e.args.length > 0 ? this.toStr(this.expr(e.args[0])) : strLit('')
      const t: CType = name === '异常' ? '异常' : `异常:${name}`
      return { c: `csay_error(${msg}, ${ERROR_KINDS[name]})`, t }
    }
    if (name === '抛出') return { c: `(${this.throwValue(this.expr(e.args[0]))}, 0LL)`, t: '无' }

    const list = this.funcs.get(name)
    if (list === undefined) {
      if (this.selfType !== null && this.classMethods !== null) {
        const overloads = this.classMethods.get(name)
        const m = overloads === undefined ? undefined : overloads.length > 1 ? overloads[e.overload ?? 0] : overloads[0]
        if (m !== undefined) {
          const args = this.callArgsWithDefaults(this.orderedArgs(e.args, m.paramNames, m.defaults, `方法「${m.name}」`), m.params, m.defaults, m.modes)
          const call = `${m.cn}(self${args.length > 0 ? ', ' + args.join(', ') : ''})`
          if (m.ret === '无') return { c: `(${call}, 0LL)`, t: '整数' }
          return { c: call, t: m.ret }
        }
      }
      throw new Unsupported(`函数「${name}」`)
    }
    let sig: FuncInfo
    if (list.length === 1) {
      sig = list[0]
    } else if (e.overload !== undefined && list[e.overload] !== undefined) {
      sig = list[e.overload]
    } else {
      if (e.args.some((a) => a.kind === 'named')) throw new Unsupported(`重载函数「${name}」的命名参数`)
      const matches = list.filter((s) => s.params.length === e.args.length)
      if (matches.length !== 1) throw new Unsupported(`重载函数「${name}」`)
      sig = matches[0]
    }
    const args = this.callArgsWithDefaults(this.orderedArgs(e.args, sig.paramNames, sig.defaults, `函数「${name}」`), sig.params, sig.defaults, sig.modes)
    return { c: `${sig.cn}(${args.join(', ')})`, t: sig.ret }
  }

  // ---------------- 语句 ----------------

  stmt(s: Stmt): void {
    if (this.debug) {
      const file = this.file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      this.push(`#line ${s.line} "${file}"`)
    }
    switch (s.kind) {
      case 'block': {
        this.push('{')
        this.indent++
        this.enter()
        for (const x of s.stmts) this.stmt(x)
        this.leave()
        this.indent--
        this.push('}')
        return
      }
      case 'var': this.varDecl(s); return
      case 'expr': this.exprStmt(s.expr); return
      case 'if': {
        this.push(`if (${this.expr(s.cond).c})`)
        this.stmt(s.then)
        if (s.els !== null) {
          this.push('else')
          this.stmt(s.els)
        }
        return
      }
      case 'while': {
        this.push(`while (${this.expr(s.cond).c})`)
        this.loopDepth++
        this.stmt(s.body)
        this.loopDepth--
        return
      }
      case 'dowhile': {
        this.push('do')
        this.loopDepth++
        this.stmt(s.body)
        this.loopDepth--
        this.push(`while (${this.expr(s.cond).c});`)
        return
      }
      case 'for': {
        let init = ''
        if (s.init !== null) {
          if (s.init.kind === 'var') {
            const t = this.resolveType(s.init.type)
            const cn = this.cname(s.init.name)
            const v = s.init.init === null ? this.defaultOf(t) : this.expr(s.init.init).c
            init = `${this.cType(t)} ${cn} = ${v}`
            this.declareVar(s.init.name, t)
          } else if (s.init.kind === 'expr') {
            init = this.expr(s.init.expr).c
          } else {
            throw new Unsupported('循环 的第一段')
          }
        }
        const cond = s.cond === null ? '' : this.expr(s.cond).c
        const step = s.step.map((x) => this.stepExpr(x)).join(', ')
        this.push(`for (${init}; ${cond}; ${step})`)
        this.loopDepth++
        this.stmt(s.body)
        this.loopDepth--
        return
      }
      case 'foreach':
        this.loopDepth++
        this.forEach(s)
        this.loopDepth--
        return
      case 'switch': this.switchStmt(s); return
      case 'try': this.tryStmt(s); return
      case 'region': {
        const id = this.fresh('rg')
        this.push('{')
        this.indent++
        this.push(`CsayRegion* ${id} = csay_region_begin();`)
        this.regionStack.push({ id, loopDepth: this.loopDepth })
        this.enter()
        for (const st of (s.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        this.leave()
        this.regionStack.pop()
        this.push(`csay_region_end(${id});`)
        this.indent--
        this.push('}')
        return
      }
      case 'using': {
        const recv = this.expr(s.target)
        if (!recv.t.startsWith('类:')) throw new Unsupported('使用 的目标必须是类对象')
        const cls = this.objName(recv.t)
        const found = this.findMethodWithOwner(cls, '关闭')
        if (found === null) throw new Unsupported(`类「${cls}」没有 关闭 方法，不能用于 使用`)
        const m = found.method
        if (m.isStatic) throw new Unsupported('使用 不能调用静态 关闭 方法')
        if (m.params.length !== 0) throw new Unsupported('关闭 方法不能带参数')
        this.checkAccess(m.vis, found.owner, '方法', m.name)
        const mods = m.raw.modifiers as string[]
        const ptr = this.fresh('use_target')
        const target = this.objPtr(recv)
        const closeCall = mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象')
          ? `Csay_dispatch_关闭(${ptr})`
          : `${m.cn}(${ptr})`
        const close = `if (${ptr} != NULL) { ${closeCall}; }`
        const id = this.fresh('use')
        const closed = `${id}_closed`
        this.push('{')
        this.indent++
        this.push(`${this.cType(recv.t)} ${ptr} = ${target};`)
        this.push(`CsayTry ${id};`)
        this.push(`int ${id}_failed = 0;`)
        this.push(`int ${closed} = 0;`)
        this.push(`${id}.prev = csay_try_top;`)
        this.push(`if (setjmp(${id}.buf) == 0) {`)
        this.indent++
        this.push(`csay_try_top = &${id};`)
        this.usingDepth++
        this.usingStack.push({ close, closed, loopDepth: this.loopDepth })
        for (const st of (s.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        this.usingStack.pop()
        this.usingDepth--
        this.push(`csay_try_top = ${id}.prev;`)
        this.indent--
        this.push('} else {')
        this.indent++
        this.push(`${id}_failed = 1;`)
        this.push(`csay_try_top = ${id}.prev;`)
        this.push(`if (!${closed}) { ${close}; }`)
        this.push(`csay_throw_error(${id}.err);`)
        this.indent--
        this.push('}')
        this.push(`if (!${closed}) { ${close}; }`)
        this.indent--
        this.push('}')
        return
      }
      case 'throw':
        this.push(`${this.throwValue(this.expr(s.value))};`)
        return
      case 'return': {
        if (s.value === null) {
          for (const u of [...this.usingStack].reverse()) {
            this.push(`${u.closed} = 1;`)
            this.push(`${u.close};`)
          }
          for (const r of [...this.regionStack].reverse()) this.push(`csay_region_end(${r.id});`)
          this.push('return;')
          return
        }
        const v = this.expr(s.value)
        let retExpr = this.coerce(v, this.currentRet ?? v.t)
        if (this.usingStack.length > 0 || this.regionStack.length > 0) {
          const ret = this.fresh('ret')
          this.push(`${this.cType(this.currentRet ?? v.t)} ${ret} = ${retExpr};`)
          retExpr = ret
        }
        for (const u of [...this.usingStack].reverse()) {
          this.push(`${u.closed} = 1;`)
          this.push(`${u.close};`)
        }
        if (this.regionStack.length > 0) {
          const scalar = v.t === '整数' || v.t === '浮点数' || v.t === '长小数' || v.t === '真假' || v.t.startsWith('枚举:')
          if (scalar) {
            // 值拷贝，直接放行
          } else if (v.t === '文本') {
            // 文本可以复制到区域外，复制完再回收区域，返回值有效
            const tmp = this.fresh('ret')
            this.push(`CsayStr ${tmp} = csay_keep_str(${v.c});`)
            retExpr = tmp
          } else {
            throw new Unsupported(
              `区域块里不能返回「${v.t}」类型的值：它内部的引用仍指向区域内的内存，`
              + '区域一回收就是悬垂。把 区域 收窄到不跨返回的位置',
            )
          }
          for (const r of [...this.regionStack].reverse()) this.push(`csay_region_end(${r.id});`)
        }
        this.push(`return ${retExpr};`)
        return
      }
      case 'break':
      case 'continue': {
        const exitingUsing = this.usingStack.filter((u) => u.loopDepth >= this.loopDepth)
        for (const u of [...exitingUsing].reverse()) {
          this.push(`${u.closed} = 1;`)
          this.push(`${u.close};`)
        }
        // 只结束「当前循环体内」的区域：循环外的区域在跳转后仍然有效
        const inner = this.regionStack.filter((r) => r.loopDepth >= this.loopDepth)
        for (const r of [...inner].reverse()) this.push(`csay_region_end(${r.id});`)
        this.push(s.kind === 'break' ? 'break;' : 'continue;')
        return
      }
      case 'empty': this.push(';'); return
      case 'localFunc': throw new Unsupported('在函数内部再定义函数')
    }
  }

  private initGlobal(s: Extract<Stmt, { kind: 'var' }>): void {
    const t = this.resolveType(s.type)
    const cn = this.cname(s.name)
    if (s.init === null) {
      if (t === '文本') this.push(`${cn} = csay_str("", 0);`)
      return
    }
    if (t.startsWith('结构:') && s.init !== null && s.init.kind === 'new') {
      const info = this.typeInfo(t)
      let ctor: CtorInfo | undefined
      let ordered: Expr[] = []
      for (const c of info.ctors) {
        const r = arrangeArguments(s.init.args, c.raw.params.map((p: Param) => p.name), c.defaults)
        if (r.error !== undefined) continue
        if (r.args.length < c.minArgs || r.args.length > c.params.length) continue
        ctor = c
        ordered = r.args
        break
      }
      if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
      this.checkCtorAccess(ctor, info.name)
      const args = this.callArgsWithDefaults(ordered, ctor.params, ctor.defaults, ctor.modes, true)
      this.push(`${cn} = ${ctor.cn}(${args.join(', ')});`)
      return
    }
    const v = this.expr(s.init)
    this.push(`${cn} = ${this.coerce(v, t)};`)
  }

  private varDecl(s: Extract<Stmt, { kind: 'var' }>): void {
    const t = this.resolveType(s.type)
    const cn = this.cname(s.name)

    if (this.isArray(t)) {
      if (s.init === null || s.init.kind === 'null') {
        this.push(`${this.cType(t)} ${cn} = NULL;`)
        this.push(`CsayInt ${cn}_len = 0;`)
        this.declareVar(s.name, t)
        return
      }
      if (s.init.kind !== 'array') {
        const v = this.expr(s.init)
        if (!this.isArray(v.t)) throw new Unsupported('数组只能用字面量、另一个数组或 空 初始化')
        const tmp = this.fresh('arr')
        this.push(`${this.cType(t)} ${tmp} = ${this.coerce(v, t)};`)
        this.push(`${this.cType(t)} ${cn} = ${tmp};`)
        this.push(`CsayInt ${cn}_len = csay_array_len(${tmp});`)
        this.declareVar(s.name, t)
        return
      }
      if (s.init.elems.length === 0) throw new Unsupported('空数组字面量')
      const elem = t.slice(0, -2)
      const items = s.init.elems.map((x) => this.coerce(this.expr(x), elem))
      this.push(`${this.cType(t)} ${cn} = (${this.cType(t)})csay_array_alloc(${items.length}, (int64_t)sizeof(${this.cType(elem)})); /* ${s.name} */`)
      items.forEach((x, i) => this.push(`${cn}[${i}] = ${x};`))
      this.push(`CsayInt ${cn}_len = ${items.length};`)
      this.declareVar(s.name, t)
      return
    }

    if (t.startsWith('结构:') && s.init !== null && s.init.kind === 'new') {
      const info = this.typeInfo(t)
      const ctor = info.ctors.find((c) => s.init!.args.length >= c.minArgs && s.init!.args.length <= c.params.length)
      if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
      this.checkCtorAccess(ctor, info.name)
      const args = this.callArgsWithDefaults(s.init.args, ctor.params, ctor.defaults, ctor.modes, true)
      this.push(`${this.cType(t)} ${cn}; /* ${s.name} */`)
      this.push(`${ctor.initCn}(${['&' + cn, ...args].join(', ')});`)
      this.declareVar(s.name, t)
      return
    }

    if (s.init === null) {
      this.push(`${this.cType(t)} ${cn} = ${this.defaultOf(t)}; /* ${s.name} */`)
    } else {
      const v = this.expr(s.init)
      this.push(`${this.cType(t)} ${cn} = ${this.coerce(v, t)}; /* ${s.name} */`)
    }
    this.declareVar(s.name, t)
  }

  private exprStmt(e: Expr): void {
    if (e.kind === 'call' && e.callee.kind === 'name' && e.callee.name === '打印') {
      if (e.args.length !== 1) throw new Unsupported('打印 需要正好一个参数')
      if (e.args[0].kind === 'null') {
        this.push(`csay_println_str(${strLit('空')});`)
        return
      }
      const v = this.expr(e.args[0])
      if (isErrorType(v.t)) { this.push(`csay_println_str(${v.c}.msg);`); return }
      switch (v.t) {
        case '浮点数': this.push(`csay_println_float32(${v.c});`); return
        case '长小数': this.push(`csay_println_float(${v.c});`); return
        case '文本': this.push(`csay_println_str(${v.c});`); return
        case '字符': this.push(`csay_println_str(csay_char_of_code(${v.c}));`); return
        case '真假': this.push(`csay_println_bool(${v.c});`); return
        case '空':
        case '未知': this.push(`csay_println_str(${strLit('空')});`); return
        default:
          if (isIntegerType(v.t)) { this.push(`csay_println_int(${v.c});`); return }
          if (v.t.startsWith('枚举:')) { this.push(`csay_println_int(${v.c});`); return }
          throw new Unsupported('打印这种值')
      }
    }
    this.push(`${this.expr(e).c};`)
  }

  private stepExpr(e: Expr): string {
    if (e.kind === 'postfix') return `${this.expr(e.operand).c}${e.op}`
    return this.expr(e).c
  }

  private forEach(s: Extract<Stmt, { kind: 'foreach' }>): void {
    const cn = this.cname(s.name)
    const body = s.body as Extract<Stmt, { kind: 'block' }>

    if (s.iter.kind === 'array') {
      if (s.iter.elems.length === 0) throw new Unsupported('遍历空数组字面量')
      const tmp = this.fresh('t')
      const elemType = this.expr(s.iter.elems[0]).t
      const items = s.iter.elems.map((x) => this.expr(x).c)
      this.push('{')
      this.indent++
      this.enter()
      this.push(`${this.cType(elemType)} ${tmp}[${items.length}] = {${items.join(', ')}};`)
      const idx = this.fresh('i')
      this.push(`for (CsayInt ${idx} = 0; ${idx} < ${items.length}; ${idx}++) {`)
      this.indent++
      this.push(`${this.cType(elemType)} ${cn} = ${tmp}[${idx}]; /* ${s.name} */`)
      this.declareVar(s.name, elemType)
      for (const st of body.stmts) this.stmt(st)
      this.indent--
      this.push('}')
      this.leave()
      this.indent--
      this.push('}')
      return
    }

    const v = this.expr(s.iter)

    if (this.isArray(v.t)) {
      const elemType = v.t.slice(0, -2)
      const idx = this.fresh('i')
      this.push(`for (CsayInt ${idx} = 0; ${idx} < ${this.arrayLenOf(s.iter, v)}; ${idx}++)`)
      this.push('{')
      this.indent++
      this.enter()
      this.push(`${this.cType(elemType)} ${cn} = ${v.c}[${idx}]; /* ${s.name} */`)
      this.declareVar(s.name, elemType)
      for (const st of body.stmts) this.stmt(st)
      this.leave()
      this.indent--
      this.push('}')
      return
    }

    if (v.t.startsWith('列表:')) {
      const elemType = v.t.slice(3)
      const idx = this.fresh('i')
      this.push(`for (CsayInt ${idx} = 0; ${idx} < ${v.c}->len; ${idx}++)`)
      this.push('{')
      this.indent++
      this.enter()
      this.push(`${this.cType(elemType)} ${cn} = *(${this.cType(elemType)}*)csay_list_at(${v.c}, ${idx}); /* ${s.name} */`)
      this.declareVar(s.name, elemType)
      for (const st of body.stmts) this.stmt(st)
      this.leave()
      this.indent--
      this.push('}')
      return
    }

    throw new Unsupported('遍历这个类型的值')
  }

  private switchStmt(s: Extract<Stmt, { kind: 'switch' }>): void {
    const subj = this.expr(s.subject)
    if (subj.t !== '整数' && !subj.t.startsWith('枚举:')) throw new Unsupported('选择 只支持整数或枚举')
    this.push(`switch (${subj.c}) {`)
    this.indent++
    for (const c of s.clauses) {
      if (c.label !== null) this.push(`case ${this.expr(c.label).c}:`)
      else this.push('default:')
      if (c.stmts.length === 0) continue
      this.push('{')
      this.indent++
      this.enter()
      for (const st of c.stmts) this.stmt(st)
      this.leave()
      this.indent--
      this.push('}')
      this.push('break;')
    }
    this.indent--
    this.push('}')
  }

  private catchKind(t: TypeRef): number {
    if (t.kind !== 'named' || ERROR_KINDS[t.name] === undefined) {
      throw new Unsupported(`捕获类型「${t.kind === 'named' ? t.name : '数组'}」不是异常类型`)
    }
    return ERROR_KINDS[t.name]
  }

  private tryStmt(s: Extract<Stmt, { kind: 'try' }>): void {
    const id = this.fresh('try')
    this.push('{')
    this.indent++
    this.push(`CsayTry ${id};`)
    this.push(`int ${id}_failed = 0;`)
    this.push(`int ${id}_handled = 0;`)
    this.push(`${id}.prev = csay_try_top;`)
    this.push(`if (setjmp(${id}.buf) == 0) {`)
    this.indent++
    this.push(`csay_try_top = &${id};`)
    for (const st of (s.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
    this.push(`csay_try_top = ${id}.prev;`)
    this.indent--
    this.push('} else {')
    this.indent++
    this.push(`${id}_failed = 1;`)
    this.push(`csay_try_top = ${id}.prev;`)
    const declaredCatches = new Set<string>()
    s.catches.forEach((c) => {
      if (declaredCatches.has(c.name)) return
      declaredCatches.add(c.name)
      this.push(`CsayError ${this.cname(c.name)} = ${id}.err; /* ${c.name} */`)
    })
    s.catches.forEach((c, i) => {
      const kind = this.catchKind(c.type)
      const cn = this.cname(c.name)
      this.enter()
      this.declareVar(c.name, '异常')
      const filter = c.filter === undefined || c.filter === null ? null : this.expr(c.filter).c
      this.leave()
      const typeCond = kind === 0 ? '1' : `${id}.err.kind == ${kind}`
      const cond = filter === null ? typeCond : `(${typeCond}) && (${filter})`
      this.push(`${i === 0 ? 'if' : 'else if'} (${cond}) {`)
      this.indent++
      this.push(`${id}_handled = 1;`)
      this.enter()
      this.declareVar(c.name, '异常')
      for (const st of (c.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
      this.leave()
      this.indent--
      this.push('}')
    })
    this.indent--
    this.push('}')
    if (s.fin !== null) {
      for (const st of (s.fin as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
    }
    if (s.catches.length > 0 || s.fin !== null) {
      this.push(`if (${id}_failed && !${id}_handled) { csay_throw_error(${id}.err); }`)
    }
    this.indent--
    this.push('}')
  }

  // ---------------- 顶层 ----------------

  generate(unit: CompilationUnit): { code: string } {
    try {
      unit = expandGenerics(unit)
    } catch (e) {
      throw new Unsupported(e instanceof Error ? e.message : String(e))
    }
    this.collect(unit)

    const localFuncs = unit.stmts.filter((s): s is Extract<Stmt, { kind: 'localFunc' }> => s.kind === 'localFunc')
    const localInfos: { f: Extract<Stmt, { kind: 'localFunc' }>; sig: FuncInfo }[] = []
    for (const f of localFuncs) {
      const list = this.funcs.get(f.name) ?? []
      const index = list.length
      const sig: FuncInfo = {
        cn: index === 0 ? `f_${f.name}` : `f_${f.name}__${index + 1}`,
        ret: this.resolveType(f.ret),
        params: f.params.map((p) => this.resolveType(p.type)),
        defaults: f.params.map((p) => p.def),
        minArgs: minArgsOf(f.params),
        paramNames: f.params.map((p) => p.name),
        modes: f.params.map((p) => p.mode ?? null),
      }
      list.push(sig)
      this.funcs.set(f.name, list)
      localInfos.push({ f, sig })
    }

    const head: string[] = []

    // 顶层变量提升为文件级全局变量：函数体里也能访问。
    const globalDecls: string[] = []
    const globalRoots: { cn: string; t: string }[] = []
    const staticRoots: { cn: string; t: string }[] = []
    for (const s of unit.stmts) {
      if (s.kind !== 'var') continue
      const t = this.resolveType(s.type)
      if (this.isArray(t)) continue
      const cn = this.cname(s.name)
      this.globalNames.add(s.name)
      this.declareVar(s.name, t)
      globalDecls.push(`static ${this.cType(t)} ${cn}; /* ${s.name} */`)
      globalRoots.push({ cn, t: this.cType(t) })
    }

    for (const info of this.types.values()) {
      if (info.kind !== 'enum') continue
      head.push(`typedef CsayInt ${info.cn};`)
      info.enumItems.forEach((it, i) => head.push(`#define ${it.cn} ${i}LL`))
      head.push('')
    }

    for (const d of this.delegateOrder) {
      const ps = ['void*', ...d.params.map((p) => this.cType(p))].join(', ')
      head.push(`typedef struct ${d.cn} ${d.cn};`)
      head.push(`struct ${d.cn} {`)
      head.push('    void* env;')
      head.push(`    ${this.cType(d.ret)} (*fn)(${ps});`)
      head.push('};')
      head.push('')
    }

    if ([...this.types.values()].some((info) => info.kind === 'class')) {
      head.push('typedef struct { CsayInt tag; } CsayClassHeader;')
      head.push('')
    }

    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      head.push(`typedef struct ${info.cn} ${info.cn};`)
    }

    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      const lines = [`struct ${info.cn} {`]
      if (info.base !== null) {
        const b = this.types.get(info.base)
        if (b === undefined || b.kind === 'interface') lines.push('    char _iface;')
        else lines.push(`    ${b.cn} base;`)
      } else if (info.kind === 'class') {
        lines.push('    CsayInt _tag;')
      }
      for (const f of info.fields) {
        if (!f.isStatic) lines.push(`    ${this.cType(f.type)} ${f.cn}; /* ${f.name} */`)
      }
      if (info.fields.every((f) => f.isStatic) && info.base === null && info.kind === 'struct') lines.push('    char _empty;')
      lines.push('};')
      head.push(...lines)
      head.push('')
    }

    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      for (const f of info.fields) {
        if (f.isStatic) {
          const cn = this.staticFieldCName(info.name, f)
          head.push(`static ${this.cType(f.type)} ${cn};`)
          staticRoots.push({ cn, t: this.cType(f.type) })
        }
      }
    }
    if ([...this.types.values()].some((info) => info.kind !== 'interface' && info.kind !== 'enum' && info.fields.some((f) => f.isStatic))) head.push('')

    // 接口：一份虚表结构 + 一份「对象指针 + 虚表指针」的引用结构
    for (const info of this.types.values()) {
      if (info.kind !== 'interface') continue
      const slots: string[] = []
      info.ifaceMethods.forEach((m, i) => {
        const ps = ['void*', ...this.ifaceParamTypes(m)].join(', ')
        slots.push(`    ${this.cType(m.ret)} (*m${i})(${ps});`)
      })
      let slot = info.ifaceMethods.length
      for (const p of info.ifaceProps) {
        if (p.hasGet) slots.push(`    ${this.cType(p.type)} (*m${slot++})(void*);`)
        if (p.hasSet) slots.push(`    void (*m${slot++})(void*, ${this.cType(p.type)});`)
      }
      if (slots.length === 0) slots.push('    char _empty;')
      head.push(`typedef struct ${info.cn}_VT {`)
      head.push(...slots)
      head.push(`} ${info.cn}_VT;`)
      head.push(`typedef struct ${info.cn}_Ref { void* obj; ${info.cn}_VT* vt; } ${info.cn}_Ref;`)
      head.push('')
    }

    const protos: string[] = []
    for (const { sig } of localInfos) {
      const ps = sig.params.flatMap((p, i) => this.paramTypes(p, sig.modes[i]))
      protos.push(`static ${this.cType(sig.ret)} ${sig.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
    }
    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      for (const c of info.ctors) {
        const ps = this.ctorParamTypes(c)
        protos.push(`static void ${c.initCn}(${[`${info.cn}* self`, ...ps].join(', ')});`)
        if (info.kind === 'class') {
          protos.push(`static ${info.cn}* ${c.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
        } else {
          protos.push(`static ${info.cn} ${c.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
        }
      }
      for (const m of info.methods) {
        if (m.raw.body === null) continue
        const ps = m.params.flatMap((p, i) => this.paramTypes(p, m.modes[i]))
        const self = m.isStatic ? [] : [`${info.cn}* self`]
        protos.push(`static ${this.cType(m.ret)} ${m.cn}(${[...self, ...ps].join(', ')});`)
      }
      for (const p of info.props) {
        const self = p.isStatic ? [] : [`${info.cn}* self`]
        if (p.getCn !== null) protos.push(`static ${this.cType(p.type)} ${p.getCn}(${self.join(', ')});`)
        if (p.setCn !== null) protos.push(`static void ${p.setCn}(${[...self, `${this.cType(p.type)} _value`].join(', ')});`)
      }
    }

    const virtualMethods = new Map<string, MethodInfo>()
    for (const info of this.types.values()) {
      if (info.kind !== 'class') continue
      for (const m of info.methods) {
        const mods = m.raw.modifiers as string[]
        if (!mods.includes('虚拟') && !mods.includes('覆盖') && !mods.includes('抽象')) continue
        const seen = virtualMethods.get(m.name)
        if (seen !== undefined) {
          if (seen.ret !== m.ret || seen.params.length !== m.params.length || seen.params.some((p, i) => p !== m.params[i]) || seen.modes.some((x, i) => x !== m.modes[i])) {
            throw new Unsupported(`虚方法「${m.name}」在不同类里的签名不一致`)
          }
        } else {
          virtualMethods.set(m.name, m)
        }
      }
    }
    for (const [name, m] of virtualMethods) {
      const ps = ['void* self', ...this.methodParamTypes(m).map((p, i) => `${p} a${i}`)]
      protos.push(`static ${this.cType(m.ret)} Csay_dispatch_${name}(${ps.join(', ')});`)
    }

    head.push(...protos)
    head.push('')

    if (globalDecls.length > 0) {
      head.push(...globalDecls)
      head.push('')
    }

    // 接口实现：每个「类 × 接口」生成一组跳板函数和一份静态虚表。
    // 跳板把 void* 转回具体类指针，再调用真实方法；虚表实例的地址在
    // 「类对象 → 接口引用」转换时被写进引用结构。
    for (const info of this.types.values()) {
      if (info.kind !== 'class' && info.kind !== 'struct') continue
      for (const ifaceName of this.allImpls(info.name)) {
        const iface = this.types.get(ifaceName)
        if (iface === undefined) continue
        const entries: string[] = []
        let slot = 0

        for (const m of iface.ifaceMethods) {
          const r = this.resolveIfaceMethod(info.name, m)
          if (r === null) {
            throw new Unsupported(`类「${info.name}」没有实现接口「${ifaceName}」的方法「${m.name}」`)
          }
          const fn = `Csay_${info.name}_impl_${ifaceName}_m${slot}`
          const ps = ['void* s', ...this.ifaceParamTypes(m).map((p, k) => `${p} a${k}`)]
          const args = [`((Csay_${r.owner}*)s)`, ...m.params.map((_, k) => `a${k}`)]
          head.push(`static ${this.cType(m.ret)} ${fn}(${ps.join(', ')}) {`)
          if (m.ret === '无') head.push(`    ${r.method.cn}(${args.join(', ')});`)
          else head.push(`    return ${r.method.cn}(${args.join(', ')});`)
          head.push('}')
          entries.push(fn)
          slot++
        }

        for (const p of iface.ifaceProps) {
          const found = this.findPropWithOwner(info.name, p.name)
          if (found === null) {
            throw new Unsupported(`类「${info.name}」没有实现接口属性「${p.name}」`)
          }
          if (p.hasGet) {
            if (found.prop.getCn === null) throw new Unsupported(`属性「${p.name}」缺少 取 访问器`)
            const fn = `Csay_${info.name}_impl_${ifaceName}_m${slot}`
            head.push(`static ${this.cType(p.type)} ${fn}(void* s) {`)
            head.push(`    return ${found.prop.getCn}((Csay_${found.owner}*)s);`)
            head.push('}')
            entries.push(fn)
            slot++
          }
          if (p.hasSet) {
            if (found.prop.setCn === null) throw new Unsupported(`属性「${p.name}」缺少 写 访问器`)
            const fn = `Csay_${info.name}_impl_${ifaceName}_m${slot}`
            head.push(`static void ${fn}(void* s, ${this.cType(p.type)} v) {`)
            head.push(`    ${found.prop.setCn}((Csay_${found.owner}*)s, v);`)
            head.push('}')
            entries.push(fn)
            slot++
          }
        }

        if (entries.length === 0) entries.push('0')
        head.push(`static ${iface.cn}_VT Csay_${info.name}_impl_${ifaceName}_VT = { ${entries.join(', ')} };`)
        head.push('')
      }
    }
    head.push('')

    const bodies: string[] = []

    for (const { f, sig } of localInfos) {
      const ps = this.paramDecls(f.params, sig.params)
      bodies.push(`static ${this.cType(sig.ret)} ${sig.cn}(${ps.length > 0 ? ps.join(', ') : 'void'}) {`)
      bodies.push(...this.bodyOf(f.params, sig.params, (f.body as Extract<Stmt, { kind: 'block' }>).stmts, null, sig.ret))
      bodies.push('}')
      bodies.push('')
    }

    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      const selfT = `${info.kind === 'class' ? '类' : '结构'}:${info.name}`

      for (const c of info.ctors) {
        const node = c.raw
        const params = node.params as Param[]
        const ps = params.map((p, i) => {
          const isRef = c.modes[i] === 'ref' || c.modes[i] === 'out'
          return `${isRef ? this.cType(c.params[i]) + '*' : this.cType(c.params[i])} ${isRef ? p.name : this.cname(p.name)} /* ${p.name} */`
        })
        bodies.push(`static void ${c.initCn}(${[`${info.cn}* self`, ...ps].join(', ')}) {`)
        const saved = this.out
        this.out = []
        this.indent = 1
        this.selfType = selfT
        this.inCtor = true
        const savedRefs = this.refNames
        this.refNames = new Map(savedRefs)
        this.enter()
        params.forEach((p, i) => {
          if (c.modes[i] === 'ref' || c.modes[i] === 'out') this.refNames.set(p.name, `(*${p.name})`)
          this.declareVar(p.name, c.params[i])
        })
        params.forEach((p, i) => {
          if (this.isArray(c.params[i])) this.push(`CsayInt ${this.cname(p.name)}_len = csay_array_len(${this.cname(p.name)});`)
        })
        if (info.base !== null) {
          const baseInfo = this.types.get(info.base)!
          const baseArgs = node.baseArgs ?? []
          if (baseInfo.ctors.length > 0) {
            let baseCtor: CtorInfo | undefined
            let baseOrdered: Expr[] = []
            for (const x of baseInfo.ctors) {
              const r = arrangeArguments(baseArgs as Expr[], x.raw.params.map((p: Param) => p.name), x.defaults)
              if (r.error !== undefined) continue
              if (r.args.length < x.minArgs || r.args.length > x.params.length) continue
              baseCtor = x
              baseOrdered = r.args
              break
            }
            if (baseCtor === undefined) throw new Unsupported('父类没有匹配的构造器')
            this.checkAccess(baseCtor.vis, info.base, '构造器', info.base)
            const args = this.callArgsWithDefaults(baseOrdered, baseCtor.params, baseCtor.defaults, baseCtor.modes, true)
            const selfPtr = baseInfo.kind === 'class' ? `((Csay_${info.base}*)self)` : '(&self->base)'
            this.push(`${baseCtor.initCn}(${[selfPtr, ...args].join(', ')});`)
          }
        }
        for (const f of info.fields) {
          if (f.isStatic) continue
          if (f.init !== null) {
            const v = this.expr(f.init)
            this.push(`self->${f.cn} = ${this.coerce(v, f.type)};`)
          } else {
            this.push(`self->${f.cn} = ${this.defaultOf(f.type)};`)
          }
        }
        for (const st of (node.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        if (info.kind === 'class') this.push(`self->${this.classTagPath(info)} = ${info.tag}LL;`)
        this.leave()
        this.refNames = savedRefs
        this.inCtor = false
        this.selfType = null
        bodies.push(...this.out)
        bodies.push('}')
        bodies.push('')
        this.out = saved
        this.indent = 0

        if (info.kind === 'class') {
          const ptrs = c.params.map((_p, i) => `p${i}`)
          const decl = c.params.length > 0
            ? this.ctorParamTypes(c).map((p, i) => `${p} ${ptrs[i]}`).join(', ')
            : 'void'
          bodies.push(`static ${info.cn}* ${c.cn}(${decl}) {`)
          bodies.push(`    ${info.cn}* self = (${info.cn}*)csay_alloc((int64_t)sizeof(${info.cn}));`)
          bodies.push(`    ${c.initCn}(${['self', ...ptrs].join(', ')});`)
          bodies.push('    return self;')
          bodies.push('}')
          bodies.push('')
        } else {
          const ptrs = c.params.map((_p, i) => `p${i}`)
          const decl = c.params.length > 0
            ? this.ctorParamTypes(c).map((p, i) => `${p} ${ptrs[i]}`).join(', ')
            : 'void'
          bodies.push(`static ${info.cn} ${c.cn}(${decl}) {`)
          bodies.push(`    ${info.cn} self;`)
          bodies.push(`    ${c.initCn}(${['&self', ...ptrs].join(', ')});`)
          bodies.push('    return self;')
          bodies.push('}')
          bodies.push('')
        }
      }

            const cmap = new Map<string, { name: string; ret: CType; params: CType[]; defaults: (Expr | null)[]; modes: ('ref' | 'out' | null)[]; minArgs: number; cn: string; paramNames: string[] }[]>()
            for (const mm of info.methods) {
              const sig = { name: mm.name, ret: mm.ret, params: mm.params, defaults: mm.defaults, modes: mm.modes, minArgs: mm.minArgs, cn: mm.cn, paramNames: mm.raw.params.map((p: Param) => p.name) }
              const prev = cmap.get(mm.name)
              if (prev === undefined) cmap.set(mm.name, [sig])
              else prev.push(sig)
            }
            this.classMethods = cmap
for (const m of info.methods) {
        if (m.raw.body === null) continue
        const node = m.raw
        const params = node.params as Param[]
        const ps = this.paramDecls(params, m.params)
        const selfParam = m.isStatic ? [] : [`${info.cn}* self`]
        bodies.push(`static ${this.cType(m.ret)} ${m.cn}(${[...selfParam, ...ps].join(', ')}) {`)
        const saved = this.out
        const savedRet = this.currentRet
        const savedRegion = this.regionStack
    const savedLoop = this.loopDepth
        const savedUsing = this.usingDepth
        const savedUsingStack = this.usingStack
        this.out = []
        this.indent = 1
        this.selfType = selfT
        this.currentRet = m.ret
        this.regionStack = []
    this.loopDepth = 0
        this.usingDepth = 0
        this.usingStack = []
        this.enter()
        const savedRefs = this.refNames
        this.refNames = new Map(savedRefs)
        if (!m.isStatic) this.declareVar('自', selfT)
        params.forEach((p, i) => {
          this.declareVar(p.name, m.params[i])
          if (p.mode === 'ref' || p.mode === 'out') this.refNames.set(p.name, `(*${p.name})`)
        })
        for (const st of (node.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        this.refNames = savedRefs
        this.leave()
        this.selfType = null
        this.currentRet = savedRet
        this.regionStack = savedRegion
    this.loopDepth = savedLoop
        this.usingDepth = savedUsing
        this.usingStack = savedUsingStack
        bodies.push(...this.out)
        bodies.push('}')
        bodies.push('')
        this.out = saved
        this.indent = 0
      }

      for (const p of info.props) {
        const node = p.raw
        this.selfType = p.isStatic ? null : selfT
        const selfParam = p.isStatic ? [] : [`${info.cn}* self`]
        for (const a of node.accessors as Accessor[]) {
          if (a.kind === 'get' && p.getCn !== null) {
            bodies.push(`static ${this.cType(p.type)} ${p.getCn}(${selfParam.join(', ')}) {`)
            bodies.push(...this.bodyOf([], [], (a.body as Extract<Stmt, { kind: 'block' }>).stmts, null, p.type))
            bodies.push('}')
            bodies.push('')
          }
          if (a.kind === 'set' && p.setCn !== null) {
            bodies.push(`static void ${p.setCn}(${[...selfParam, `${this.cType(p.type)} _value`].join(', ')}) {`)
            bodies.push(...this.bodyOf([], [], (a.body as Extract<Stmt, { kind: 'block' }>).stmts, p.type, '无'))
            bodies.push('}')
            bodies.push('')
          }
        }
        this.selfType = null
      }
    }

    for (const [name, sig] of virtualMethods) {
      const ps = ['void* self', ...this.methodParamTypes(sig).map((p, i) => `${p} a${i}`)]
      bodies.push(`static ${this.cType(sig.ret)} Csay_dispatch_${name}(${ps.join(', ')}) {`)
      bodies.push('    switch (((CsayClassHeader*)self)->tag) {')
      let cases = 0
      for (const info of this.types.values()) {
        if (info.kind !== 'class' || info.tag === 0) continue
        const found = this.findMethodWithOwner(info.name, name)
        if (found === null) continue
        const mods = found.method.raw.modifiers as string[]
        if (!mods.includes('虚拟') && !mods.includes('覆盖') && !mods.includes('抽象')) continue
        if (found.method.raw.body === null) continue
        const args = [`((${this.types.get(found.owner)!.cn}*)self)`, ...sig.params.map((_p, i) => `a${i}`)]
        const call = `${found.method.cn}(${args.join(', ')})`
        bodies.push(`        case ${info.tag}LL:`)
        if (sig.ret === '无') {
          bodies.push(`            ${call};`)
          bodies.push('            return;')
        } else bodies.push(`            return ${call};`)
        cases++
      }
      bodies.push('        default:')
      if (sig.ret === '无') bodies.push('            return;')
      else bodies.push(`            return ${this.defaultOf(sig.ret)};`)
      bodies.push('    }')
      bodies.push('}')
      bodies.push('')
    }

    let hasReturn = false
    for (const s of unit.stmts) if (s.kind === 'return') hasReturn = true

    const staticInitTypes = [...this.types.values()].filter((info) =>
      info.kind !== 'interface' && info.kind !== 'enum' && info.fields.some((f) => f.isStatic && f.init !== null))
    bodies.push(...this.staticInitBodies())
    bodies.push('int main(int argc, char** argv) {')
    bodies.push('    csay_gc_init(&argc);')
    for (const r of [...globalRoots, ...staticRoots]) {
      bodies.push(`    csay_gc_add_root(&${r.cn}, (int64_t)sizeof(${r.cn}));`)
    }
    bodies.push('    csay_win_init();')
    // 用 atexit 保证任何退出路径（顶层 返回、异常、正常结束）都会走收尾
    bodies.push('    atexit(csay_win_finish);')
    bodies.push('    g_csay_argc = argc; g_csay_argv = argv;')
    for (const info of staticInitTypes) bodies.push(`    ${info.cn}_static_init();`)
    const saved = this.out
    this.out = []
    this.indent = 1
    this.selfType = null
    this.classMethods = null
    this.enter()
    for (const s of unit.stmts) {
      if (s.kind === 'localFunc') continue
      if (s.kind === 'var') {
        if (this.globalNames.has(s.name)) this.initGlobal(s)
        else this.varDecl(s)
        continue
      }
      this.stmt(s)
    }
    this.leave()
    bodies.push(...this.out)
    if (!hasReturn) bodies.push('    return 0;')
    bodies.push('}')
    this.out = saved
    this.indent = 0

    const code = [RUNTIME_C, ...head, ...this.lambdaProtos, ...this.lambdaBodies, ...bodies, ''].join('\n')
    return { code }
  }

  /** 生成函数体：参数入作用域、值上下文可选，返回缩进后的行数组 */
  private bodyOf(
    params: Param[], paramTypes: CType[], stmts: Stmt[],
    valueType: CType | null, retType: CType | null = null,
  ): string[] {
    const saved = this.out
    const savedIndent = this.indent
    const savedRet = this.currentRet
    const savedRegion = this.regionStack
    const savedLoop = this.loopDepth
    const savedUsing = this.usingDepth
    const savedUsingStack = this.usingStack
    this.out = []
    this.indent = 1
    this.currentRet = retType
    this.regionStack = []
    this.loopDepth = 0
    this.usingDepth = 0
    this.usingStack = []
    this.enter()
    const savedRefs = this.refNames
    this.refNames = new Map(savedRefs)
    params.forEach((p, i) => {
      if (p.mode === 'ref' || p.mode === 'out') this.refNames.set(p.name, `(*${p.name})`)
      this.declareVar(p.name, paramTypes[i])
    })
    if (valueType !== null) this.declareVar('__value__', valueType)
    for (const st of stmts) this.stmt(st)
    this.leave()
    this.refNames = savedRefs
    const result = this.out
    this.out = saved
    this.indent = savedIndent
    this.currentRet = savedRet
    this.regionStack = savedRegion
    this.loopDepth = savedLoop
    this.usingDepth = savedUsing
    this.usingStack = savedUsingStack
    return result
  }
}

export function generate(unit: CompilationUnit, file: string, debug = false): { code: string } {
  return new CodeGen(file, debug).generate(unit)
}
