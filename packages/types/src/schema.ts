/**
 * 模块职责：配置表单描述（WebUI 自动渲染的唯一数据源）
 * 依赖方向：叶子模块
 * 生命周期：纯类型
 * 注意事项：内核的 schema 构造器（`@yunzai-ng/core` 的 `s.*`）一次声明同时产出**校验器**
 *          与此处的描述结构体，故校验规则与面板表单由同一份声明推导，不会改了校验而漏掉表单。
 */

/** WebUI 控件提示 */
export type SchemaWidget =
  | "text"
  | "textarea"
  | "password"
  | "number"
  | "switch"
  | "select"
  | "multiselect"
  | "tags"
  | "slider"
  | "code"
  | "file"
  | "dir"
  | "cron"
  | "duration"
  | "uid"
  | "keyValue"

/** 枚举项 */
export interface SchemaEnumItem {
  /** 实际值 */
  value: string | number | boolean
  /** 展示文案，缺省用 value */
  label?: string
  /** 补充说明 */
  description?: string
}

/** 校验问题的严重程度 */
export type IssueSeverity = "error" | "warn"

/**
 * 一条校验问题
 *
 * 放在类型包而不是内核里，是因为它有**两个**消费方：内核的 `SchemaError.issues`，
 * 以及面板前端 —— 写配置失败时服务端会把这个数组原样放进 400 响应体，
 * 前端据此把错误标到对应的表单字段上。两边共用一份声明才不会各自漂移。
 */
export interface SchemaIssue {
  /** 出问题的字段路径，如 `"server.port"`；根节点为空串 */
  path: string
  /** 中文说明 */
  message: string
  /** 严重程度；`warn` 不阻止解析成功 */
  severity: IssueSeverity
}

/**
 * 配置字段描述
 *
 * 是 JSON Schema 的一个受控子集：仅保留 WebUI 确实需要的部分，
 * 以免前端为兼容完整 JSON Schema 而编写大量分支。
 */
export interface SchemaDescriptor {
  /** 字段类型 */
  type: "object" | "array" | "string" | "number" | "boolean" | "enum" | "record" | "unknown"
  /** 表单标签 */
  title?: string
  /** 表单说明/帮助文案 */
  description?: string
  /** 默认值 */
  default?: unknown
  /** 是否必填 */
  required?: boolean
  /** 是否敏感字段：WebUI 读取时脱敏、日志中不打印 */
  secret?: boolean
  /** 是否只读（如自动生成的 id） */
  readonly?: boolean
  /** 控件提示 */
  widget?: SchemaWidget
  /** 分组名，WebUI 据此折叠成若干区块 */
  group?: string
  /** 排序权重，小的在前 */
  order?: number

  /** type=object 时的子字段 */
  properties?: Record<string, SchemaDescriptor>
  /** type=array 时的元素描述 */
  items?: SchemaDescriptor
  /** type=record 时的值描述 */
  values?: SchemaDescriptor
  /** type=enum 时的候选项 */
  enum?: SchemaEnumItem[]

  /** 数值/字符串长度下界 */
  min?: number
  /** 数值/字符串长度上界 */
  max?: number
  /** 数值步长 */
  step?: number
  /** 字符串正则（源文本） */
  pattern?: string
  /** 输入框占位符 */
  placeholder?: string

  /**
   * 条件显隐
   *
   * 形如 `{ "mode": "ws-reverse" }`：当同级字段 mode 等于该值时才显示。
   * NapCat 适配器的四种网络模式就靠它，避免把无关字段全摊在页面上。
   */
  showWhen?: Record<string, unknown>
}
