import z from "zod"
import { Tool } from "./tool"
import { abortAfterAny } from "../util/abort"

const SEARCH_URL = "https://google.serper.dev/search"

interface SerperSearchResult {
  organic?: Array<{
    title: string
    link: string
    snippet?: string
    position: number
  }>
  answerBox?: {
    answer?: string
    snippet?: string
    title?: string
  }
  knowledgeGraph?: {
    title?: string
    description?: string
  }
  topStories?: Array<{
    title: string
    link: string
    snippet?: string
  }>
}

export const SerperSearchTool = Tool.define("serper_search", {
  description:
    "Search the web using Google via Serper API. Returns organic search results, answer boxes, and knowledge graph data. Requires SERPER_API_KEY environment variable.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    num: z.number().int().min(1).max(20).optional().describe("Number of results to return (default: 10)"),
    gl: z.string().optional().describe("Country code for search results, e.g. 'us', 'cn' (default: us)"),
    hl: z.string().optional().describe("Language code for search results, e.g. 'en', 'zh-cn' (default: en)"),
  }),
  async execute(params, ctx) {
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) throw new Error("SERPER_API_KEY environment variable is not set")

    await ctx.ask({
      permission: "websearch",
      patterns: [params.query],
      always: ["*"],
      metadata: { query: params.query },
    })

    const { signal, clearTimeout } = abortAfterAny(15000, ctx.abort)

    try {
      const body: Record<string, unknown> = { q: params.query }
      if (params.num) body.num = params.num
      if (params.gl) body.gl = params.gl
      if (params.hl) body.hl = params.hl

      const response = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      })

      clearTimeout()

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Serper search failed (${response.status}): ${text}`)
      }

      const data = (await response.json()) as SerperSearchResult
      const lines: string[] = []

      if (data.answerBox?.answer || data.answerBox?.snippet) {
        lines.push("## Answer")
        lines.push(data.answerBox.answer ?? data.answerBox.snippet ?? "")
        lines.push("")
      }

      if (data.knowledgeGraph?.title) {
        lines.push(`## ${data.knowledgeGraph.title}`)
        if (data.knowledgeGraph.description) lines.push(data.knowledgeGraph.description)
        lines.push("")
      }

      if (data.organic?.length) {
        lines.push("## Results")
        for (const item of data.organic) {
          lines.push(`### ${item.position}. ${item.title}`)
          lines.push(`URL: ${item.link}`)
          if (item.snippet) lines.push(item.snippet)
          lines.push("")
        }
      }

      if (data.topStories?.length) {
        lines.push("## Top Stories")
        for (const story of data.topStories) {
          lines.push(`- [${story.title}](${story.link})`)
          if (story.snippet) lines.push(`  ${story.snippet}`)
        }
      }

      const output = lines.join("\n").trim() || "No results found."
      return {
        title: `Search: ${params.query}`,
        output,
        metadata: {},
      }
    } catch (error) {
      clearTimeout()
      if (error instanceof Error && error.name === "AbortError") throw new Error("Search request timed out")
      throw error
    }
  },
})
