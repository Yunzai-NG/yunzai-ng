/**
 * 模块职责：`@yunzai-ng/jsx` 的行为固定
 * 依赖方向：测试文件，只引本包
 * 生命周期：无状态
 * 注意事项：此处固定的是"默认转义"这一安全口径。米游社返回的昵称、公告标题、兑换码
 *          说明均为用户可控文本，其中出现一个尖括号即可破坏整张图的结构，而这种数据
 *          只在真机上才会出现 —— 必须由单测把住。
 */
import { describe, expect, it } from "vitest"
import { attributes, children, cx, defineTemplate, element, escape, Fragment, Html, jsx, jsxs, raw, style } from "./index.js"

describe("escape", () => {
  it("转义五个危险字符", () => {
    expect(escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  it("空值转为空串而不是字面量", () => {
    expect(escape(null)).toBe("")
    expect(escape(undefined)).toBe("")
  })

  it("数字与零照常输出", () => {
    expect(escape(0)).toBe("0")
    expect(escape(12.5)).toBe("12.5")
  })
})

describe("Html", () => {
  it("raw 跳过转义", () => {
    expect(raw("<b>x</b>").toString()).toBe("<b>x</b>")
  })

  it("可被 JSON 序列化为文本，便于快照", () => {
    expect(JSON.stringify(raw("<i>"))).toBe('"<i>"')
  })

  it("能被判定", () => {
    expect(Html.is(raw(""))).toBe(true)
    expect(Html.is("<b>")).toBe(false)
    expect(Html.is(null)).toBe(false)
  })
})

describe("cx", () => {
  it("接纳字符串、字典与嵌套数组", () => {
    expect(cx("cont", ["full", ["wide"]], { up: true, down: false })).toBe("cont full wide up")
  })

  it("丢弃空值", () => {
    expect(cx(null, undefined, false, "")).toBe("")
  })

  it("去重", () => {
    expect(cx("cont", "cont cell")).toBe("cont cell")
  })
})

describe("style", () => {
  it("驼峰键转为连字符", () => {
    expect(style({ fontSize: "13px", backgroundColor: "red" })).toBe("font-size: 13px; background-color: red")
  })

  it("自定义属性保留原始大小写", () => {
    expect(style({ "--gapX": "4px" })).toBe("--gapX: 4px")
  })

  it("数值原样输出，不自动补 px", () => {
    expect(style({ "z-index": 3 })).toBe("z-index: 3")
  })

  it("字符串原样通过", () => {
    expect(style("width: 50%")).toBe("width: 50%")
  })
})

describe("children", () => {
  it("布尔与空值渲染为空串，使短路写法可直接书写", () => {
    expect(children([true, false, null, undefined])).toBe("")
  })

  it("文本被转义，Html 原样通过", () => {
    expect(children(["<b>", raw("<b>")])).toBe("&lt;b&gt;<b>")
  })

  it("数组任意嵌套", () => {
    expect(children([["a", ["b"]], "c"])).toBe("abc")
  })

  it("零会被渲染出来", () => {
    expect(children(0)).toBe("0")
  })
})

describe("attributes", () => {
  it("class 与 className 合并成一个属性", () => {
    expect(attributes({ class: "cont", className: { full: true } })).toBe(' class="cont full"')
  })

  it("htmlFor 映射为 for", () => {
    expect(attributes({ htmlFor: "x" })).toBe(' for="x"')
  })

  it("true 输出裸属性名，false 与空值整项省略", () => {
    expect(attributes({ hidden: true, disabled: false, title: null })).toBe(" hidden")
  })

  it("style 接受字典", () => {
    expect(attributes({ style: { width: "50%" } })).toBe(' style="width: 50%"')
  })

  it("属性值被转义，无法逃出引号", () => {
    expect(attributes({ title: 'a" onload="alert(1)' })).toBe(' title="a&quot; onload=&quot;alert(1)"')
  })

  it("children 与 key 不进属性", () => {
    expect(attributes({ children: "x", key: 1 })).toBe("")
  })

  it("非法属性名直接抛错，而不是静默丢弃", () => {
    expect(() => attributes({ "a b": "1" })).toThrow(/非法的属性名/)
  })
})

describe("element", () => {
  it("空元素不输出闭合标签", () => {
    expect(element("img", { src: "a.png" })).toBe('<img src="a.png">')
    expect(element("br", {})).toBe("<br>")
  })

  it("普通元素带闭合标签与子节点", () => {
    expect(element("div", { class: "cont", children: "文本" })).toBe('<div class="cont">文本</div>')
  })

  it("非法标签名直接抛错", () => {
    expect(() => element("div onload=x", {})).toThrow(/非法的标签名/)
  })
})

describe("jsx 运行时", () => {
  it("按编译器实际发出的形态调用", () => {
    expect(jsx("span", { children: "x" }).toString()).toBe("<span>x</span>")
    expect(jsxs("ul", { children: [jsx("li", { children: 1 }), jsx("li", { children: 2 })] }).toString()).toBe(
      "<ul><li>1</li><li>2</li></ul>"
    )
  })

  it("jsxs 与 jsx 是同一实现", () => {
    expect(jsxs).toBe(jsx)
  })

  it("函数组件被调用并展开", () => {
    const Card = (props: { title: string }): Html => jsx("h1", { children: props.title })
    expect(jsx(Card, { title: "深渊" }).toString()).toBe("<h1>深渊</h1>")
  })

  it("Fragment 只拼接子节点，不产生标签", () => {
    expect(jsx(Fragment, { children: ["a", "b"] }).toString()).toBe("ab")
  })

  it("属性缺省时也能渲染", () => {
    expect(jsx("hr").toString()).toBe("<hr>")
  })
})

describe("defineTemplate", () => {
  it("产出带 doctype 的完整页面与页面名", () => {
    const Page = defineTemplate("demo", (props: { uid: string }) => jsx("html", { children: props.uid }))
    expect(Page({ uid: "1" })).toEqual({ name: "demo", html: "<!DOCTYPE html><html>1</html>" })
  })
})
