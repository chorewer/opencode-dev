import z from "zod"
import { Tool } from "./tool"
import { abortAfterAny } from "../util/abort"

const SCRAPE_URL = "https://scrape.serper.dev"

const MAX_OUTPUT = 50000

export const SerperBrowseTool = Tool.define("serper_browse", {
  description:
    "Fetch and extract content from a web page using Serper Scrape API. Returns the page content in markdown format. More reliable than direct fetch for JS-heavy sites. Requires SERPER_API_KEY environment variable.",
  parameters: z.object({
    url: z.string().describe("The URL of the web page to scrape"),
  }),
  async execute(params, ctx) {
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) throw new Error("SERPER_API_KEY environment variable is not set")

    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: ["*"],
      metadata: { url: params.url },
    })

    const { signal, clearTimeout } = abortAfterAny(30000, ctx.abort)

    try {
      const response = await fetch(SCRAPE_URL, {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: params.url, includeMarkdown: true }),
        signal,
      })

      clearTimeout()

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Serper browse failed (${response.status}): ${text}`)
      }

      const data = (await response.json()) as { markdown?: string; text?: string; title?: string }
      const content = data.markdown ?? data.text ?? ""
      const output = content.length > MAX_OUTPUT ? content.slice(0, MAX_OUTPUT) + "\n\n[content truncated]" : content

      return {
        title: data.title ?? params.url,
        output: output || "No content extracted.",
        metadata: {},
      }
    } catch (error) {
      clearTimeout()
      if (error instanceof Error && error.name === "AbortError") throw new Error("Browse request timed out")
      throw error
    }
  },
})
