# @yunzai-ng/jsx

给写渲染模板的人的一个可选 JSX 运行时。产出 HTML 字符串,不涉及浏览器。

## 为什么不是 core 的一个子路径

分层门禁把 `@yunzai-ng/core/*` 的任意子路径判为「深引内核内部实现」。为一个 JSX 运行时给门禁
开洞不划算;独立成包之后,第三方插件也能只依赖它而不牵入整个内核。

## 用法

在插件的 `tsconfig.json` 里指向它:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@yunzai-ng/jsx"
  }
}
```

然后模板就是一个函数:

```tsx
import { Html, cx } from "@yunzai-ng/jsx"

export function Profile({ name, level }: { name: string; level: number }) {
  return (
    <Html title={name}>
      <div class={cx("card", level >= 60 && "card-max")}>
        <h1>{name}</h1>
        <p>等级 {level}</p>
      </div>
    </Html>
  )
}
```

把它的返回值交给 `ctx.render()`。

## 两处要注意

**默认转义。** 插进去的值一律转义,故用户昵称里的 `<script>` 不会变成脚本。确实要插入原始
HTML 时用 `raw()` —— 它显眼,便于审阅时逐个确认。

**`cx()` 与 `style()` 是为条件拼接准备的。** 手写 `class={"a " + (b ? "c" : "")}` 会在条件为假时
留下一个尾随空格,而某些工具类框架对空 class 的处理并不一致。
