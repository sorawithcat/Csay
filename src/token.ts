// Csay 词法单元定义。规格见 docs/EBNF与词法-v1.md

/** 53 个保留字，与 docs/EBNF与词法-v1.md 第 6.3 节严格一致 */
export const KEYWORDS = new Set<string>([
  // 类型 7
  '整数', '小数', '文本', '真假', '字节', '无', '任意',
  // 访问 4
  '公开', '私有', '保护', '内部',
  // 修饰 6
  '静态', '只读', '抽象', '虚拟', '覆盖', '常', '密封',
  // 定义 4
  '类', '结构', '接口', '枚举', '委托',
  // 自指 2
  '自', '基',
  // 控制 16
  '若', '否则', '否则若', '择', '情形', '默认', '对于', '遍历',
  '只要', '做', '在', '返回', '跳出', '跳过', '区域', '使用',
  // 异常 4
  '试', '捕获', '最终', '抛出',
  // 表达式 4
  '新', '空', '真', '假',
  // 模块 2
  '引', '空间',
  // 属性 2
  '取', '写',
])

/**
 * 上下文关键字：只在特定位置才是关键字，其他位置可以当普通名字。
 * 「值」只在属性的 写 { } 里代表被赋的新值（对应 C# 的 value）。
 * 中文里「值」太常用了，做成保留字会逼用户改变量名。
 */
export const CONTEXTUAL_KEYWORDS = new Set<string>(['值'])

export type TokenKind =
  | 'keyword'   // 保留字
  | 'ident'     // 标识符
  | 'int'       // 整数字面量
  | 'float'     // 小数字面量
  | 'string'    // 文本字面量（含插值片段）
  | 'op'        // 运算符与分隔符
  | 'eof'

/** 字符串插值的片段 */
export type StringSegment =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; tokens: Token[] }

export interface Token {
  kind: TokenKind
  /** 原始文本。字符串为去掉引号后的原文，eof 为空串 */
  text: string
  /** 1 基行号 */
  line: number
  /** 1 基列号 */
  col: number
  /** 仅 string：插值片段；无插值时为空数组 */
  segments?: StringSegment[]
  /** 仅 string：是否带 $ 前缀 */
  interpolated?: boolean
}

export type Severity = 'error' | 'warning'

export interface Diagnostic {
  severity: Severity
  line: number
  col: number
  /** 中文报错正文 */
  message: string
  /** 修改建议，通常是一行可直接替换的代码 */
  hint?: string
  /** 出错的文件名，多文件编译时才有意义 */
  file?: string
}

/**
 * 全角字符 → 半角替换建议。
 * 中文输入法混入全角是高频事故，必须在词法层单独拦截给出提示。
 */
export const FULLWIDTH_MAP = new Map<string, { half: string; hint: string }>([
  ['（', { half: '(', hint: '请改用半角括号 ( ' }],
  ['）', { half: ')', hint: '请改用半角括号 )' }],
  ['｛', { half: '{', hint: '请改用半角花括号 {' }],
  ['｝', { half: '}', hint: '请改用半角花括号 }' }],
  ['，', { half: ',', hint: '代码里不用中文逗号，请改用 ,' }],
  ['；', { half: ';', hint: '代码里不用中文分号，请改用 ;' }],
  ['：', { half: ':', hint: '代码里不用中文冒号，请改用 :' }],
  ['＝', { half: '=', hint: '请改用半角等号 =' }],
  ['＋', { half: '+', hint: '请改用半角加号 +' }],
  ['－', { half: '-', hint: '请改用半角减号 -' }],
  ['＊', { half: '*', hint: '请改用半角星号 *' }],
  ['／', { half: '/', hint: '请改用半角斜杠 /' }],
  ['＜', { half: '<', hint: '请改用半角小于号 <' }],
  ['＞', { half: '>', hint: '请改用半角大于号 >' }],
  ['！', { half: '!', hint: '请改用半角叹号 !' }],
  ['　', { half: ' ', hint: '全角空格不能用作分隔，请改用半角空格' }],
  ['。', { half: ';', hint: '语句以 ; 结束，不需要句号' }],
  ['×', { half: '*', hint: '请改用半角乘号 *' }],
  ['÷', { half: '/', hint: '请改用半角除号 /' }],
  ['【', { half: '[', hint: '请改用半角方括号 [ ' }],
  ['】', { half: ']', hint: '请改用半角方括号 ]' }],
])

/** 多字符运算符，按长度降序匹配 */
export const OPERATORS_2 = new Set<string>([
  '++', '--', '+=', '-=', '*=', '/=', '%=',
  '==', '!=', '<=', '>=', '&&', '||', '=>',
])

export const OPERATORS_1 = new Set<string>([
  '+', '-', '*', '/', '%', '=', '<', '>', '!',
  '?', ':', '.', ',', ';', '(', ')', '[', ']', '{', '}',
])
