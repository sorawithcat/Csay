// Csay 代码生成器：AST → C 源码。
// 类型用字符串编码，避免引入庞大的联合类型：
//   基本类型  整数 / 小数 / 文本 / 真假 / 无
//   数组      整数[] 等
//   对象      类:点 / 结构:点
//   枚举      枚举:星期
//   容器      列表:整数 / 表:文本:整数
//   内置      条目（CsayEntry）/ 异常（CsayStr）
// 遇到真正做不了的东西抛 Unsupported，绝不生成半截错误的 C。

import { Buffer } from 'node:buffer'
import type { CompilationUnit, Stmt, Expr, TypeRef, Param, Accessor, Decl } from './ast.ts'
import { RUNTIME_C } from './runtime.ts'
import { expandGenerics } from './generics.ts'

export class Unsupported extends Error {}

type CType = string

const PRIM: Record<string, CType> = {
  '整数': '整数', '小数': '小数', '文本': '文本', '真假': '真假', '无': '无',
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

interface FieldInfo { name: string; cn: string; type: CType; vis: Visibility; isPrivate: boolean; isReadonly: boolean; isStatic: boolean; init: Expr | null }
interface MethodInfo {
  name: string; cn: string; ret: CType; params: CType[]; isStatic: boolean; vis: Visibility; isPrivate: boolean; raw: any
}
interface PropInfo {
  name: string; type: CType; getCn: string | null; setCn: string | null; vis: Visibility; isPrivate: boolean; raw: any
}
interface CtorInfo { cn: string; initCn: string; params: CType[]; raw: any }
interface IfaceMethod { name: string; cn: string; ret: CType; params: CType[] }
interface IfaceProp { name: string; type: CType; hasGet: boolean; hasSet: boolean }
interface DelegateInfo { name: string; cn: string; params: CType[]; ret: CType; raw: any }
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

interface Value { c: string; t: CType; env?: string }

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

/** 空间只做声明分组，编译时展开为同一作用域的声明。 */
function flattenDecls(decls: Decl[]): Decl[] {  const out: Decl[] = []
  for (const d of decls) {
    if (d.kind === 'namespace') out.push(...flattenDecls(d.decls))
    else out.push(d)
  }
  return out
}

export class CodeGen {
  private out: string[] = []
  private names = new Map<string, string>()
  private counter = 0
  private scopes: Map<string, CType>[] = [new Map()]
  private funcs = new Map<string, { cn: string; ret: CType; params: CType[] }>()
  private types = new Map<string, TypeInfo>()
  private delegates = new Map<string, DelegateInfo>()
  private delegateOrder: DelegateInfo[] = []
  private lambdaProtos: string[] = []
  private lambdaBodies: string[] = []
  private lambdaCounter = 0
  private lambdaVoidBlock = false
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
  private usingDepth = 0
  private loopDepth = 0
  /** 当前正在生成的方法所属的类，方法表供裸调用同类方法使用 */
  private classMethods: Map<string, { ret: CType; params: CType[]; cn: string }> | null = null
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
    if (t.name === '列表' || t.name === '集合' || t.name === '队列' || t.name === '栈') {
      if (t.typeArgs.length !== 1) throw new Unsupported(`${t.name} 需要 1 个类型参数`)
      return `列表:${this.resolveType(t.typeArgs[0])}`
    }
    if (t.name === '表') {
      if (t.typeArgs.length !== 2) throw new Unsupported('表 需要 2 个类型参数')
      const k = this.resolveType(t.typeArgs[0])
      const v = this.resolveType(t.typeArgs[1])
      if (k !== '文本' && k !== '整数') throw new Unsupported('表的键只支持 文本 或 整数')
      if (!['整数', '小数', '文本', '真假'].includes(v)) throw new Unsupported('表的值只支持基本类型')
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
      case '整数': return 'CsayInt'
      case '小数': return 'CsayFloat'
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
    if (t.endsWith('[]')) return this.cType(t.slice(0, -2))
    if (t.startsWith('列表:')) return 'CsayList*'
    if (t.startsWith('委托:')) return this.delegates.get(t.slice(3))!.cn
    if (t.startsWith('枚举:')) return 'Csay_' + t.slice(3)
    if (t.startsWith('接口:')) return 'Csay_' + t.slice(3) + '_Ref'
    if (t.startsWith('类:')) return 'Csay_' + t.slice(2) + '*'
    if (t.startsWith('结构:')) return 'Csay_' + t.slice(3)
    throw new Unsupported(`类型 ${t}`)
  }

  /** 接口引用的 C 类型名，用于构造复合字面量 */
  private refType(t: CType): string {
    return this.cType(t)
  }

  /**
   * 类型适配：把值变成目标类型。
   * 目前只有一种转换——类对象 → 接口引用（带上虚表指针）。
   */
  private coerce(v: Value, target: CType): string {
    if (target.startsWith('委托:')) {
      const d = this.delegates.get(target.slice(3))
      if (d === undefined) throw new Unsupported(`委托 ${target}`)
      if (v.t === target) return v.c
      if (v.t.startsWith('函数:')) {
        const sig = `函数:${d.params.join(',')}->${d.ret}`
        if (v.t !== sig) throw new Unsupported(`Lambda 签名与委托「${d.name}」不一致`)
        return `(${this.cType(target)}){ ${v.env ?? '0'}, ${v.c} }`
      }
      throw new Unsupported(`把「${v.t}」赋给委托「${d.name}」`)
    }
    if (v.t.startsWith('函数:')) throw new Unsupported('Lambda 只能赋给委托变量或参数')
    if (isErrorType(target)) {
      if (v.t === '文本') return `csay_error(${v.c}, ${errorKindOf(target)})`
      return v.c
    }
    if (!target.startsWith('接口:')) return v.c
    const iface = target.slice(3)
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
    if (t === '整数') return '0'
    if (t === '小数') return '0.0'
    if (t === '文本') return 'csay_str("", 0)'
    if (t === '真假') return 'false'
    if (t === '无') return ''
    if (isErrorType(t)) return 'csay_error(csay_str("", 0), 0)'
    if (t.startsWith('委托:')) return `(${this.cType(t)}){ 0 }`
    return 'NULL'
  }

  private isArray(t: CType): boolean { return t.endsWith('[]') }
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

  private findField(owner: string, name: string): { path: string[]; type: CType; name: string; vis: Visibility; isReadonly: boolean; owner: string } | null {
    let cur: string | null = owner
    const path: string[] = []
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const f = info.fields.find((x) => x.name === name && !x.isStatic)
      if (f !== undefined) return { path: [...path, f.cn], type: f.type, name: f.name, vis: f.vis, isReadonly: f.isReadonly, owner: cur }
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

  private staticFieldCName(owner: string, field: FieldInfo): string {
    return `${this.types.get(owner)!.cn}_${field.cn}`
  }

  private findMethodWithOwner(owner: string, name: string): { owner: string; method: MethodInfo } | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const m = info.methods.find((x) => x.name === name)
      if (m !== undefined) return { owner: cur, method: m }
      if (info.base === null) return null
      cur = info.base
    }
    return null
  }
  private findMethod(owner: string, name: string): MethodInfo | null {
    let cur: string | null = owner
    while (cur !== null) {
      const info = this.types.get(cur)
      if (info === undefined) return null
      const m = info.methods.find((x) => x.name === name)
      if (m !== undefined) return m
      if (info.base === null) return null
      cur = info.base
    }
    return null
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
      const info: DelegateInfo = { name: d.name, cn: `Csay_${d.name}`, params: [], ret: '无', raw: d }
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
          if (isStatic && m.init !== null) throw new Unsupported(`静态字段「${m.name}」暂不支持初始化`)
          info.fields.push({ name: m.name, cn: `m${fi++}`, type: this.resolveType(m.type), vis, isPrivate: vis === '私有', isReadonly: m.modifiers.includes('只读') || m.modifiers.includes('常'), isStatic, init: m.init })
        } else if (m.kind === 'method') {
          const vis = this.visOf(m.modifiers)
          info.methods.push({
            name: m.name,
            cn: `${info.cn}_${m.name}`,
            ret: this.resolveType(m.ret),
            params: m.params.map((p) => this.resolveType(p.type)),
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
      if (md !== undefined) return { owner: cur, method: md }
      cur = info.base
    }
    return null
  }

  // ---------------- 表达式 ----------------

  expr(e: Expr): Value {
    switch (e.kind) {
      case 'int': return { c: `${e.text}LL`, t: '整数' }
      case 'float': return { c: e.text, t: '小数' }
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
            return { c: this.staticFieldCName(sf.owner, sf), t: sf.type }
          }
          const field = this.findField(owner, e.name)
          if (field !== null) {
            this.checkAccess(field.vis, field.owner, '字段', field.name)
            const path = 'self->' + field.path.join('.')
            return { c: path, t: field.type }
          }
          const prop = this.findProp(owner, e.name)
          if (prop !== null && prop.getCn !== null) {
            const found = this.findPropWithOwner(owner, e.name)!
            this.checkAccess(prop.vis, found.owner, '属性', prop.name)
            return { c: `${prop.getCn}(self)`, t: prop.type }
          }
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
        const elem = this.expr(e.elems[0]).t
        const items = e.elems.map((x) => this.coerce(this.expr(x), elem))
        return { c: `(${this.cType(elem)}[]){${items.join(', ')}}`, t: `${elem}[]` }
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
    const captures: Array<{ name: string; type: CType; c: string }> = []
    for (const name of names) {
      if (name === '自') {
        if (this.selfType !== null) captures.push({ name, type: this.selfType, c: 'self' })
        continue
      }
      if (this.scopes[0]?.has(name)) continue
      const t = this.lookup(name)
      if (t === undefined) continue
      if (t.endsWith('[]')) throw new Unsupported('Lambda 暂不支持捕获数组')
      captures.push({ name, type: t, c: this.cname(name) })
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
    const savedLoop = this.loopDepth
    const savedMethods = this.classMethods
    const savedVoidBlock = this.lambdaVoidBlock

    this.out = []
    this.indent = 1
    this.scopes = [new Map(this.scopes[0] ?? [])]
    this.currentRet = null
    this.selfType = hasSelf ? savedSelf : null
    this.inCtor = false
    this.regionStack = []
    this.usingDepth = 0
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
      this.lambdaVoidBlock = true
      for (const st of e.body.stmts) this.stmt(st)
      this.lambdaVoidBlock = false
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
    this.loopDepth = savedLoop
    this.classMethods = savedMethods
    this.lambdaVoidBlock = savedVoidBlock

    const decls = e.params.map((p, i) => `${this.cType(params[i])} ${this.cname(p.name)}`)
    const ps = ['void* env', ...decls].join(', ')
    const bindings: string[] = []
    let env: string | undefined
    if (captures.length > 0) {
      const fields = captures.map((c, i) => `${this.cType(c.type)} c${i};`)
      this.lambdaProtos.push(`typedef struct ${envCn} { ${fields.join(' ')} } ${envCn};`)
      const envParams = captures.map((c, i) => `${this.cType(c.type)} a${i}`).join(', ')
      this.lambdaProtos.push(`static void* ${envCn}_alloc(${envParams});`)
      this.lambdaBodies.push(`static void* ${envCn}_alloc(${envParams}) {`)
      this.lambdaBodies.push(`    ${envCn}* e = (${envCn}*)csay_alloc((int64_t)sizeof(${envCn}));`)
      captures.forEach((c, i) => this.lambdaBodies.push(`    e->c${i} = a${i};`))
      this.lambdaBodies.push('    return (void*)e;')
      this.lambdaBodies.push('}')
      this.lambdaBodies.push('')
      bindings.push(`    ${envCn}* e = (${envCn}*)env;`)
      captures.forEach((c, i) => {
        if (c.name === '自') bindings.push(`    ${this.cType(c.type)} self = e->c${i};`)
        else bindings.push(`    ${this.cType(c.type)} ${c.c} = e->c${i};`)
      })
      env = `${envCn}_alloc(${captures.map((c) => c.c).join(', ')})`
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
      case '整数': return `csay_str_of_int(${v.c})`
      case '小数': return `csay_str_of_float(${v.c})`
      case '真假': return `csay_str_of_bool(${v.c})`
      default: throw new Unsupported('把这种值转成文本')
    }
  }

  private throwValue(v: Value): string {
    if (isErrorType(v.t)) return `csay_throw_error(${v.c})`
    return `csay_throw(${this.toStr(v)})`
  }

  private binary(op: string, le: Expr, re: Expr): Value {
    const l = this.expr(le)
    const r = this.expr(re)
    if (op === '==' || op === '!=') {
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
      const t: CType = l.t === '小数' || r.t === '小数' ? '小数' : '整数'
      if (op === '%' && t === '小数') throw new Unsupported('小数取余')
      return { c: `(${l.c} ${op} ${r.c})`, t }
    }
    throw new Unsupported(`运算符 ${op}`)
  }

  /** 数组参数在 C 里要拆成「指针 + 长度」两个形参 */
  private paramTypes(t: CType): string[] {
    if (this.isArray(t)) return [`${this.cType(t)}*`, 'CsayInt']
    return [this.cType(t)]
  }

  private paramDecls(params: Param[], types: CType[]): string[] {
    const out: string[] = []
    params.forEach((p, i) => {
      const cn = this.cname(p.name)
      if (this.isArray(types[i])) {
        out.push(`${this.cType(types[i])}* ${cn} /* ${p.name} */`, `CsayInt ${cn}_len`)
      } else {
        out.push(`${this.cType(types[i])} ${cn} /* ${p.name} */`)
      }
    })
    return out
  }

  /** 实参展开：数组要额外传长度 */
  private callArgs(args: Expr[], targets: CType[]): string[] {
    const out: string[] = []
    args.forEach((a, i) => {
      const v = this.expr(a)
      if (this.isArray(targets[i])) {
        if (!this.isArray(v.t)) throw new Unsupported('数组参数只能传数组变量，不能传字面量')
        out.push(v.c, `${v.c}_len`)
      } else {
        out.push(this.coerce(v, targets[i]))
      }
    })
    return out
  }

  private objPtr(v: Value): string {
    return this.isClass(v.t) ? v.c : `(&${v.c})`
  }

  /** 表类型的键值类型：'表:文本:整数' → { k:'文本', v:'整数' } */
  private mapParts(t: CType): { k: CType; v: CType } {
    const parts = t.split(':')
    if (parts[0] !== '表' || parts.length !== 3) throw new Unsupported(`表类型 ${t}`)
    return { k: parts[1], v: parts[2] }
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
            const v = this.coerce(this.expr(e.value), sf.type)
            return { c: `(${this.staticFieldCName(sf.owner, sf)} ${e.op} ${v})`, t: sf.type }
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
          if (field.isReadonly && !this.inCtor) throw new Unsupported(`只读字段「${field.name}」只能在构造器里赋值`)
          const path = field.path.join('.')
          const acc = this.isClass(tgt.t) ? `${this.objPtr(tgt)}->${path}` : `${tgt.c}.${path}`
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
        if (field.isReadonly && !this.inCtor) throw new Unsupported(`只读字段「${field.name}」只能在构造器里赋值`)
      }
    }
    const target = this.expr(e.target)
    const value = this.expr(e.value)
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

  private member(e: Extract<Expr, { kind: 'member' }>): Value {
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
          return { c: this.staticFieldCName(sf.owner, sf), t: sf.type }
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
        const path = field.path.join('.')
        const code = this.isClass(tgt.t) ? `${this.objPtr(tgt)}->${path}` : e.target.kind === 'this' ? `self->${path}` : `${tgt.c}.${path}`
        return { c: code, t: field.type }
      }
      const prop = this.findProp(owner, name)
      if (prop !== null) {
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
    if (tgt.t.startsWith('列表:') && name === '数量') return { c: `${tgt.c}->len`, t: '整数' }
    if (tgt.t.startsWith('表:') && name === '数量') return { c: `${tgt.c}->len`, t: '整数' }
    if (this.isArray(tgt.t) && name === '长度') return { c: `${tgt.c}_len`, t: '整数' }
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
      const hashFn = k === '文本' ? 'csay_hash_str' : 'csay_hash_int'
      const eqFn = k === '文本' ? 'csay_eq_str' : 'csay_eq_int'
      return {
        c: `csay_map_new((int64_t)sizeof(${this.cType(k)}), (int64_t)sizeof(${this.cType(v)}), ${hashFn}, ${eqFn})`,
        t,
      }
    }
    if (!this.isObj(t)) throw new Unsupported(`新 ${t}`)
    const info = this.typeInfo(t)
    if (info.isAbstract) throw new Unsupported(`抽象类「${info.name}」不能实例化`)
    const ctor = info.ctors.find((c) => c.params.length === e.args.length)
    if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
    const args = this.callArgs(e.args, ctor.params)
    return { c: `${ctor.cn}(${args.join(', ')})`, t }
  }

  private delegateCall(t: CType, recv: string, args: Expr[]): Value {
    const d = this.delegates.get(t.slice(3))
    if (d === undefined) throw new Unsupported(`委托 ${t}`)
    if (args.length !== d.params.length) throw new Unsupported(`委托「${d.name}」需要 ${d.params.length} 个参数`)
    const vals = args.map((a, i) => this.coerce(this.expr(a), d.params[i]))
    const tmp = this.fresh('dg')
    const fn = `${tmp}.fn(${[`${tmp}.env`, ...vals].join(', ')})`
    return {
      c: `({ ${this.cType(t)} ${tmp} = ${recv}; if (${tmp}.fn == NULL) csay_throw_error(csay_error(${strLit('委托为空')}, 2)); ${fn}; })`,
      t: d.ret,
    }
  }

  private call(e: Extract<Expr, { kind: 'call' }>): Value {
    if (e.callee.kind === 'name') {
      const t = this.lookup(e.callee.name)
      if (t !== undefined && t.startsWith('委托:')) {
        return this.delegateCall(t, this.cname(e.callee.name), e.args)
      }
    }
    if (e.callee.kind === 'member' && e.callee.target.kind === 'name') {
      const info = this.types.get(e.callee.target.name)
      if (info !== undefined && (info.kind === 'class' || info.kind === 'struct')) {
        const m = this.findMethod(info.name, e.callee.name)
        if (m !== null) {
          if (!m.isStatic) throw new Unsupported(`方法「${e.callee.name}」不是静态方法`)
          this.checkAccess(m.vis, info.name, '方法', m.name)
          return { c: `${m.cn}(${this.callArgs(e.args, m.params).join(', ')})`, t: m.ret }
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
        const args = e.args.map((a, i) => this.coerce(this.expr(a), m.params[i]))
        return {
          c: `${recv.c}.vt->m${idx}(${[`${recv.c}.obj`, ...args].join(', ')})`,
          t: m.ret,
        }
      }

      if (this.isObj(recv.t)) {
        const found = this.findMethodWithOwner(this.objName(recv.t), name)
        if (found === null) throw new Unsupported(`方法「${name}」`)
        const m = found.method
        this.checkAccess(m.vis, found.owner, '方法', m.name)
        const args = this.callArgs(e.args, m.params)
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
        if (name === '查找') {
          const v = this.expr(e.args[0])
          const fn = elem === '整数'
            ? `csay_list_index_int(${recv.c}, ${v.c})`
            : elem === '小数'
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
            : elem === '小数'
              ? 'csay_cmp_float'
              : elem === '文本'
                ? 'csay_cmp_str'
                : null
          if (fn === null) throw new Unsupported(`列表排序（元素类型 ${elem}）`)
          return { c: `(csay_list_sort(${recv.c}, ${fn}), 0LL)`, t: '无' }
        }
        if (name === '最大') {
          if (elem !== '整数') throw new Unsupported('列表的最大值（仅整数）')
          return { c: `csay_list_max_int(${recv.c})`, t: '整数' }
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
            : elem === '小数'
              ? 'csay_list_unique_float'
              : elem === '文本'
                ? 'csay_list_unique_str'
                : null
          if (fn === null) throw new Unsupported(`列表去重（元素类型 ${elem}）`)
          return { c: `(${fn}(${recv.c}), 0LL)`, t: '无' }
        }
        const simple = elem === '整数'
          ? 'int'
          : elem === '小数'
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
        if (name === '转小数') return { c: `csay_str_to_float(${recv.c})`, t: '小数' }
        throw new Unsupported(`文本的方法「${name}」`)
      }
      throw new Unsupported(`这个类型的方法「${name}」`)
    }

    if (e.callee.kind !== 'name') throw new Unsupported('把表达式当函数调用')
    const name = e.callee.name

    if (name === '打印') throw new Unsupported('打印 只能作为语句使用')
    if (name === '退出') {
      const a = e.args[0] === undefined ? { c: '0', t: '整数' } : this.expr(e.args[0])
      return { c: `(csay_exit(${a.c}), 0LL)`, t: '无' }
    }
    if (name === '读文件') return { c: `csay_read_file(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '当前时间') return { c: 'csay_now()', t: '文本' }
    if (name === '当前日期') return { c: 'csay_today()', t: '文本' }
    if (name === '时间戳') return { c: 'csay_timestamp()', t: '整数' }
    if (name === '格式化时间') {
      return { c: `csay_format_time(${this.expr(e.args[0]).c}, ${this.expr(e.args[1]).c})`, t: '文本' }
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
    if (name === '开方') return { c: `sqrt((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '正弦') return { c: `sin((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '余弦') return { c: `cos((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '正切') return { c: `tan((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '反正弦') return { c: `asin((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '反余弦') return { c: `acos((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '反正切') return { c: `atan((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '反正切2') {
      const y = this.expr(e.args[0])
      const x = this.expr(e.args[1])
      return { c: `atan2((double)(${y.c}), (double)(${x.c}))`, t: '小数' }
    }
    if (name === '自然对数') return { c: `log((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '常用对数') return { c: `log10((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '指数') return { c: `exp((double)(${this.expr(e.args[0]).c}))`, t: '小数' }
    if (name === '幂') {
      const a = this.expr(e.args[0])
      const b = this.expr(e.args[1])
      return { c: `pow((double)(${a.c}), (double)(${b.c}))`, t: '小数' }
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
      const rt = a.t === '小数' || b.t === '小数' ? '小数' : '整数'
      const op = name === '最大' ? '>' : '<'
      return { c: `((${a.c}) ${op} (${b.c}) ? (${a.c}) : (${b.c}))`, t: rt }
    }
    if (name === '圆周率') return { c: '3.14159265358979323846', t: '小数' }
    if (name === '随机') return { c: 'csay_random()', t: '小数' }
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
    if (name === '格式化小数') {
      const v = this.expr(e.args[0])
      const d = this.expr(e.args[1])
      return { c: `csay_format_float(${v.c}, ${d.c})`, t: '文本' }
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
    if (name === 'JSON文本') return { c: `csay_json_text(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === 'JSON解析') {
      const s = this.expr(e.args[0])
      if (s.t !== '文本') throw new Unsupported('JSON解析() 的参数必须是文本')
      return { c: `csay_json_parse(${s.c})`, t: '表:文本:文本' }
    }
    if (name === 'JSON序列化') {
      const v = this.expr(e.args[0])
      if (v.t === '文本') return { c: `csay_json_text(${v.c})`, t: '文本' }
      if (v.t === '整数') return { c: `csay_str_of_int(${v.c})`, t: '文本' }
      if (v.t === '小数') return { c: `csay_str_of_float(${v.c})`, t: '文本' }
      if (v.t === '真假') return { c: `csay_json_bool(${v.c})`, t: '文本' }
      if (v.t === '列表:文本') return { c: `csay_json_list(${v.c}, 0)`, t: '文本' }
      if (v.t === '列表:整数') return { c: `csay_json_list(${v.c}, 1)`, t: '文本' }
      if (v.t === '列表:小数') return { c: `csay_json_list(${v.c}, 2)`, t: '文本' }
      if (v.t === '列表:真假') return { c: `csay_json_list(${v.c}, 3)`, t: '文本' }
      throw new Unsupported(`JSON序列化() 暂不支持「${v.t}」`)
    }
    if (name === '字符') return { c: `csay_char_of_code(${this.expr(e.args[0]).c})`, t: '文本' }
    if (name === '保留') {
      const a = this.expr(e.args[0])
      if (a.t !== '文本') throw new Unsupported('保留() 目前只支持文本')
      return { c: `csay_keep_str(${a.c})`, t: '文本' }
    }
    if (name === '输入') return { c: 'csay_read_line()', t: '文本' }
    if (name === '询问') return { c: 'csay_ask(' + this.expr(e.args[0]).c + ')', t: '文本' }
    if (name === '转整数') return { c: 'csay_str_to_int(' + this.expr(e.args[0]).c + ')', t: '整数' }
    if (name === '转小数') return { c: 'csay_str_to_float(' + this.expr(e.args[0]).c + ')', t: '小数' }
    if (name === '取整') return { c: `csay_round(${this.expr(e.args[0]).c})`, t: '整数' }
    if (name === '绝对值') {
      const a = this.expr(e.args[0])
      return { c: `fabs((double)(${a.c}))`, t: '小数' }
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

    const sig = this.funcs.get(name)
    if (sig === undefined) {
      if (this.selfType !== null && this.classMethods !== null) {
        const m = this.classMethods.get(name)
        if (m !== undefined) {
          const args = this.callArgs(e.args, m.params)
          const call = `${m.cn}(self${args.length > 0 ? ', ' + args.join(', ') : ''})`
          if (m.ret === '无') return { c: `(${call}, 0LL)`, t: '整数' }
          return { c: call, t: m.ret }
        }
      }
      throw new Unsupported(`函数「${name}」`)
    }
    const args = this.callArgs(e.args, sig.params)
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
            throw new Unsupported('对于 的第一段')
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
        const ptr = this.objPtr(recv)
        const close = mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象')
          ? `Csay_dispatch_关闭(${ptr})`
          : `${m.cn}(${ptr})`
        const id = this.fresh('use')
        this.push('{')
        this.indent++
        this.push(`CsayTry ${id};`)
        this.push(`int ${id}_failed = 0;`)
        this.push(`${id}.prev = csay_try_top;`)
        this.push(`if (setjmp(${id}.buf) == 0) {`)
        this.indent++
        this.push(`csay_try_top = &${id};`)
        this.usingDepth++
        for (const st of (s.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        this.usingDepth--
        this.push(`csay_try_top = ${id}.prev;`)
        this.indent--
        this.push('} else {')
        this.indent++
        this.push(`${id}_failed = 1;`)
        this.push(`csay_try_top = ${id}.prev;`)
        this.push(`${close};`)
        this.push(`csay_throw_error(${id}.err);`)
        this.indent--
        this.push('}')
        this.push(`${close};`)
        this.indent--
        this.push('}')
        return
      }
      case 'throw':
        this.push(`${this.throwValue(this.expr(s.value))};`)
        return
      case 'return': {
        if (this.lambdaVoidBlock) throw new Unsupported('Lambda 块体暂不支持 返回；请改用表达式体')
        if (this.usingDepth > 0) throw new Unsupported('使用 块里不能 返回')
        if (s.value === null) {
          for (const r of [...this.regionStack].reverse()) this.push(`csay_region_end(${r.id});`)
          this.push('return;')
          return
        }
        const v = this.expr(s.value)
        let retExpr = this.coerce(v, this.currentRet ?? v.t)
        if (this.regionStack.length > 0) {
          const scalar = v.t === '整数' || v.t === '小数' || v.t === '真假' || v.t.startsWith('枚举:')
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
        if (this.usingDepth > 0) throw new Unsupported('使用 块里不能 跳出 或 跳过')
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
      const ctor = info.ctors.find((c) => c.params.length === s.init!.args.length)
      if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
      const args = s.init.args.map((a) => this.expr(a).c)
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
      if (s.init === null || s.init.kind !== 'array') throw new Unsupported('数组只能用字面量初始化')
      if (s.init.elems.length === 0) throw new Unsupported('空数组字面量')
      const elem = t.slice(0, -2)
      const items = s.init.elems.map((x) => this.coerce(this.expr(x), elem))
      this.push(`${this.cType(elem)} ${cn}[${items.length}] = {${items.join(', ')}}; /* ${s.name} */`)
      this.push(`CsayInt ${cn}_len = ${items.length};`)
      this.declareVar(s.name, t)
      return
    }

    if (t.startsWith('结构:') && s.init !== null && s.init.kind === 'new') {
      const info = this.typeInfo(t)
      const ctor = info.ctors.find((c) => c.params.length === s.init!.args.length)
      if (ctor === undefined) throw new Unsupported(`${info.name} 没有匹配的构造器`)
      const args = s.init.args.map((a) => this.expr(a).c)
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
      const v = this.expr(e.args[0])
      if (isErrorType(v.t)) { this.push(`csay_println_str(${v.c}.msg);`); return }
      switch (v.t) {
        case '整数': this.push(`csay_println_int(${v.c});`); return
        case '小数': this.push(`csay_println_float(${v.c});`); return
        case '文本': this.push(`csay_println_str(${v.c});`); return
        case '真假': this.push(`csay_println_bool(${v.c});`); return
        default:
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
      this.push(`for (CsayInt ${idx} = 0; ${idx} < ${v.c}_len; ${idx}++)`)
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
    if (subj.t !== '整数' && !subj.t.startsWith('枚举:')) throw new Unsupported('择 只支持整数或枚举')
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
    s.catches.forEach((c, i) => {
      const kind = this.catchKind(c.type)
      const cond = kind === 0 ? '1' : `${id}.err.kind == ${kind}`
      this.push(`${i === 0 ? 'if' : 'else if'} (${cond}) {`)
      this.indent++
      this.push(`${id}_handled = 1;`)
      const cn = this.cname(c.name)
      this.push(`CsayError ${cn} = ${id}.err; /* ${c.name} */`)
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
    for (const f of localFuncs) {
      this.funcs.set(f.name, {
        cn: `f_${f.name}`,
        ret: this.resolveType(f.ret),
        params: f.params.map((p) => this.resolveType(p.type)),
      })
    }

    const head: string[] = []

    // 顶层变量提升为文件级全局变量：函数体里也能访问。
    const globalDecls: string[] = []
    for (const s of unit.stmts) {
      if (s.kind !== 'var') continue
      const t = this.resolveType(s.type)
      if (this.isArray(t)) continue
      const cn = this.cname(s.name)
      this.globalNames.add(s.name)
      this.declareVar(s.name, t)
      globalDecls.push(`static ${this.cType(t)} ${cn}; /* ${s.name} */`)
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
        if (f.isStatic) head.push(`static ${this.cType(f.type)} ${this.staticFieldCName(info.name, f)};`)
      }
    }
    if ([...this.types.values()].some((info) => info.kind !== 'interface' && info.kind !== 'enum' && info.fields.some((f) => f.isStatic))) head.push('')

    // 接口：一份虚表结构 + 一份「对象指针 + 虚表指针」的引用结构
    for (const info of this.types.values()) {
      if (info.kind !== 'interface') continue
      const slots: string[] = []
      info.ifaceMethods.forEach((m, i) => {
        const ps = ['void*', ...m.params.map((p) => this.cType(p))].join(', ')
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
    for (const f of localFuncs) {
      const sig = this.funcs.get(f.name)!
      const ps = sig.params.flatMap((p) => this.paramTypes(p))
      protos.push(`static ${this.cType(sig.ret)} ${sig.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
    }
    for (const info of this.types.values()) {
      if (info.kind === 'interface' || info.kind === 'enum') continue
      for (const c of info.ctors) {
        const ps = c.params.map((p) => this.cType(p))
        protos.push(`static void ${c.initCn}(${[`${info.cn}* self`, ...ps].join(', ')});`)
        if (info.kind === 'class') {
          protos.push(`static ${info.cn}* ${c.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
        } else {
          protos.push(`static ${info.cn} ${c.cn}(${ps.length > 0 ? ps.join(', ') : 'void'});`)
        }
      }
      for (const m of info.methods) {
        if (m.raw.body === null) continue
        const ps = m.params.flatMap((p) => this.paramTypes(p))
        const self = m.isStatic ? [] : [`${info.cn}* self`]
        protos.push(`static ${this.cType(m.ret)} ${m.cn}(${[...self, ...ps].join(', ')});`)
      }
      for (const p of info.props) {
        if (p.getCn !== null) protos.push(`static ${this.cType(p.type)} ${p.getCn}(${info.cn}* self);`)
        if (p.setCn !== null) protos.push(`static void ${p.setCn}(${info.cn}* self, ${this.cType(p.type)} _value);`)
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
          if (seen.ret !== m.ret || seen.params.length !== m.params.length || seen.params.some((p, i) => p !== m.params[i])) {
            throw new Unsupported(`虚方法「${m.name}」在不同类里的签名不一致`)
          }
        } else {
          virtualMethods.set(m.name, m)
        }
      }
    }
    for (const [name, m] of virtualMethods) {
      const ps = ['void* self', ...m.params.map((p, i) => `${this.cType(p)} a${i}`)]
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
          const ps = ['void* s', ...m.params.map((p, k) => `${this.cType(p)} a${k}`)]
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

    for (const f of localFuncs) {
      const sig = this.funcs.get(f.name)!
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
        const ps = params.map((p, i) => `${this.cType(c.params[i])} ${this.cname(p.name)} /* ${p.name} */`)
        bodies.push(`static void ${c.initCn}(${[`${info.cn}* self`, ...ps].join(', ')}) {`)
        const saved = this.out
        this.out = []
        this.indent = 1
        this.selfType = selfT
        this.inCtor = true
        this.enter()
        params.forEach((p, i) => this.declareVar(p.name, c.params[i]))
        if (info.base !== null) {
          const baseInfo = this.types.get(info.base)!
          const baseArgs = node.baseArgs ?? []
          if (baseInfo.ctors.length > 0) {
            const baseCtor = baseInfo.ctors.find((x) => x.params.length === baseArgs.length)
            if (baseCtor === undefined) throw new Unsupported('父类没有匹配的构造器')
            const args = (baseArgs as Expr[]).map((a) => this.expr(a).c)
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
            ? c.params.map((p, i) => `${this.cType(p)} ${ptrs[i]}`).join(', ')
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
            ? c.params.map((p, i) => `${this.cType(p)} ${ptrs[i]}`).join(', ')
            : 'void'
          bodies.push(`static ${info.cn} ${c.cn}(${decl}) {`)
          bodies.push(`    ${info.cn} self;`)
          bodies.push(`    ${c.initCn}(${['&self', ...ptrs].join(', ')});`)
          bodies.push('    return self;')
          bodies.push('}')
          bodies.push('')
        }
      }

            this.classMethods = new Map(info.methods.map((mm) => [mm.name, { ret: mm.ret, params: mm.params, cn: mm.cn }]))
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
        this.out = []
        this.indent = 1
        this.selfType = selfT
        this.currentRet = m.ret
        this.regionStack = []
    this.loopDepth = 0
        this.enter()
        if (!m.isStatic) this.declareVar('自', selfT)
        params.forEach((p, i) => this.declareVar(p.name, m.params[i]))
        for (const st of (node.body as Extract<Stmt, { kind: 'block' }>).stmts) this.stmt(st)
        this.leave()
        this.selfType = null
        this.currentRet = savedRet
        this.regionStack = savedRegion
    this.loopDepth = savedLoop
        bodies.push(...this.out)
        bodies.push('}')
        bodies.push('')
        this.out = saved
        this.indent = 0
      }

      for (const p of info.props) {
        const node = p.raw
        this.selfType = selfT
        for (const a of node.accessors as Accessor[]) {
          if (a.kind === 'get' && p.getCn !== null) {
            bodies.push(`static ${this.cType(p.type)} ${p.getCn}(${info.cn}* self) {`)
            bodies.push(...this.bodyOf([], [], (a.body as Extract<Stmt, { kind: 'block' }>).stmts, null, p.type))
            bodies.push('}')
            bodies.push('')
          }
          if (a.kind === 'set' && p.setCn !== null) {
            bodies.push(`static void ${p.setCn}(${info.cn}* self, ${this.cType(p.type)} _value) {`)
            bodies.push(...this.bodyOf([], [], (a.body as Extract<Stmt, { kind: 'block' }>).stmts, p.type, '无'))
            bodies.push('}')
            bodies.push('')
          }
        }
        this.selfType = null
      }
    }

    for (const [name, sig] of virtualMethods) {
      const ps = ['void* self', ...sig.params.map((p, i) => `${this.cType(p)} a${i}`)]
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
        if (sig.ret === '无') bodies.push(`            ${call};`)
        else bodies.push(`            return ${call};`)
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

    bodies.push('int main(int argc, char** argv) {')
    bodies.push('    csay_win_init();')
    // 用 atexit 保证任何退出路径（顶层 返回、异常、正常结束）都会走收尾
    bodies.push('    atexit(csay_win_finish);')
    bodies.push('    g_csay_argc = argc; g_csay_argv = argv;')
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
    this.out = []
    this.indent = 1
    this.currentRet = retType
    this.regionStack = []
    this.loopDepth = 0
    this.enter()
    params.forEach((p, i) => this.declareVar(p.name, paramTypes[i]))
    if (valueType !== null) this.declareVar('__value__', valueType)
    for (const st of stmts) this.stmt(st)
    this.leave()
    const result = this.out
    this.out = saved
    this.indent = savedIndent
    this.currentRet = savedRet
    this.regionStack = savedRegion
    this.loopDepth = savedLoop
    return result
  }
}

export function generate(unit: CompilationUnit, file: string, debug = false): { code: string } {
  return new CodeGen(file, debug).generate(unit)
}
