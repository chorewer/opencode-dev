import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { Filesystem } from "@/util/filesystem"

export const ChangeDirectoryTool = Tool.define("change_directory", async () => ({
  description:
    "Set the session working directory to the given path. Subsequent requests and tools will use this directory. Path can be absolute or relative to the current session directory.",
  parameters: z.object({
    dir: z.string().describe("Directory path (absolute or relative to current session directory)"),
  }),
  async execute(params, ctx) {
    const resolved = path.isAbsolute(params.dir)
      ? params.dir
      : path.resolve(Instance.directory, params.dir)
    const isDir = await Filesystem.isDir(resolved).catch(() => false)
    if (!isDir) throw new Error(`Not a directory or does not exist: ${resolved}`)
    await Session.setDirectory({ sessionID: ctx.sessionID, directory: resolved })

    const session = await Session.get(ctx.sessionID)
    const normalizedDir = path.resolve(resolved).replaceAll("\\", "/")
    const pattern = (normalizedDir.endsWith("/") ? normalizedDir : normalizedDir + "/") + "*"
    const rules = [...(session.permission ?? [])]
    const existing = rules.some(
      (r) => r.permission === "external_directory" && r.pattern === pattern && r.action === "allow",
    )
    if (!existing) {
      rules.push({ permission: "external_directory", pattern, action: "allow" as const })
      await Session.setPermission({ sessionID: ctx.sessionID, permission: rules })
    }

    return {
      title: "change_directory",
      metadata: {},
      output: `Session working directory set to ${resolved}. Subsequent requests will use this path.`,
    }
  },
}))
