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
    return {
      title: "change_directory",
      metadata: {},
      output: `Session working directory set to ${resolved}. Subsequent requests will use this path.`,
    }
  },
}))
