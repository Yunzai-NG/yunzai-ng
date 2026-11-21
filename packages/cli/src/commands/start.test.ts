import { describe, expect, it } from "vitest"
import { bannerToken } from "./start.js"

describe("启动横幅", () => {
  it("仅在输入、输出都是终端时显示令牌", () => {
    for (const input of [true, false, undefined]) {
      for (const output of [true, false, undefined]) {
        const text = bannerToken("sample-token", input, output)
        if (input && output) expect(text).toBe("sample-token")
        else {
          expect(text).not.toContain("sample-token")
          expect(text).toContain("server.token")
        }
      }
    }
  })
})
