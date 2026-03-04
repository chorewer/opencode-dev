#!/usr/bin/env bun
import * as Lark from "@larksuiteoapi/node-sdk"

// ============ Auth ============

function client() {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    console.error("Error: FEISHU_APP_ID and FEISHU_APP_SECRET environment variables are required")
    process.exit(1)
  }
  const domain = process.env.FEISHU_DOMAIN === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu
  return new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild, domain })
}

// ============ Helpers ============

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

type LarkResponse<T = unknown> = { code?: number; msg?: string; data?: T }

function ensure<T>(res: LarkResponse<T>, api: string): asserts res is LarkResponse<T> & { code: 0 } {
  if (res.code !== 0) {
    fail(`[${api}] code=${res.code} message=${res.msg ?? "unknown error"}`)
  }
}

const FIELD_TYPES: Record<number, string> = {
  1: "Text",
  2: "Number",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
}

// ============ Core ============

function parseBitableUrl(url: string) {
  try {
    const u = new URL(url)
    const tableId = u.searchParams.get("table") ?? undefined
    const wiki = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/)
    if (wiki?.[1]) return { token: wiki[1] as string, tableId, isWiki: true }
    const base = u.pathname.match(/\/base\/([A-Za-z0-9]+)/)
    if (base?.[1]) return { token: base[1] as string, tableId, isWiki: false }
    return null
  } catch {
    return null
  }
}

async function appTokenFromWiki(c: Lark.Client, nodeToken: string): Promise<string> {
  const res = await c.wiki.space.getNode({ params: { token: nodeToken } })
  ensure(res, "wiki.space.getNode")
  const node = res.data?.node
  if (!node) fail("Node not found")
  if (node!.obj_type !== "bitable") fail(`Node is not a bitable (type: ${node!.obj_type})`)
  return node!.obj_token ?? fail("Missing obj_token")
}

// ============ Commands ============

async function cmdGetMeta(args: string[]) {
  const url = args[0]
  if (!url) fail("Usage: get-meta <url>")
  const c = client()
  const parsed = parseBitableUrl(url!)
  if (!parsed) fail("Invalid URL. Expected /base/XXX or /wiki/XXX")

  const p = parsed!
  const appToken = (p.isWiki ? await appTokenFromWiki(c, p.token) : p.token) as string

  const res = await c.bitable.app.get({ path: { app_token: appToken } })
  ensure(res, "bitable.app.get")

  let tables: { table_id: string; name: string }[] = []
  if (!p.tableId) {
    const tablesRes = await c.bitable.appTable.list({ path: { app_token: appToken } })
    if (tablesRes.code === 0) {
      tables = (tablesRes.data?.items ?? []).map((t) => ({ table_id: t.table_id!, name: t.name! }))
    }
  }

  out({
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other commands`
      : `Use app_token="${appToken}". Select a table_id from the tables list.`,
  })
}

async function cmdListFields(args: string[]) {
  const [appToken, tableId] = args
  if (!appToken || !tableId) fail("Usage: list-fields <app_token> <table_id>")
  const c = client()
  const res = await c.bitable.appTableField.list({ path: { app_token: appToken, table_id: tableId } })
  ensure(res, "bitable.appTableField.list")
  out({
    fields: (res.data?.items ?? []).map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      type_name: FIELD_TYPES[f.type ?? 0] || `type_${f.type}`,
      is_primary: f.is_primary,
      ...(f.property && { property: f.property }),
    })),
    total: res.data?.items?.length ?? 0,
  })
}

async function cmdListRecords(args: string[]) {
  const [appToken, tableId, ...rest] = args
  if (!appToken || !tableId) fail("Usage: list-records <app_token> <table_id> [--page-size N] [--page-token T]")
  const c = client()

  let pageSize = 100
  let pageToken: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--page-size" && rest[i + 1]) pageSize = parseInt(rest[++i]!, 10)
    if (rest[i] === "--page-token" && rest[i + 1]) pageToken = rest[++i]!
  }

  const res = await c.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: pageSize, ...(pageToken && { page_token: pageToken }) },
  })
  ensure(res, "bitable.appTableRecord.list")
  out({
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  })
}

async function cmdGetRecord(args: string[]) {
  const [appToken, tableId, recordId] = args
  if (!appToken || !tableId || !recordId) fail("Usage: get-record <app_token> <table_id> <record_id>")
  const c = client()
  const res = await c.bitable.appTableRecord.get({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
  })
  ensure(res, "bitable.appTableRecord.get")
  out({ record: res.data?.record })
}

async function cmdCreateRecord(args: string[]) {
  const [appToken, tableId, fieldsJson] = args
  if (!appToken || !tableId || !fieldsJson) fail("Usage: create-record <app_token> <table_id> <fields_json>")
  const fields = JSON.parse(fieldsJson) as Record<string, unknown>
  const c = client()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await c.bitable.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    data: { fields: fields as any },
  })
  ensure(res, "bitable.appTableRecord.create")
  out({ record: res.data?.record })
}

async function cmdUpdateRecord(args: string[]) {
  const [appToken, tableId, recordId, fieldsJson] = args
  if (!appToken || !tableId || !recordId || !fieldsJson)
    fail("Usage: update-record <app_token> <table_id> <record_id> <fields_json>")
  const fields = JSON.parse(fieldsJson) as Record<string, unknown>
  const c = client()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await c.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    data: { fields: fields as any },
  })
  ensure(res, "bitable.appTableRecord.update")
  out({ record: res.data?.record })
}

async function cmdCreateApp(args: string[]) {
  const [name, ...rest] = args
  if (!name) fail("Usage: create-app <name> [--folder-token T]")
  const c = client()

  let folderToken: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--folder-token" && rest[i + 1]) folderToken = rest[++i]
  }

  const res = await c.bitable.app.create({ data: { name, ...(folderToken && { folder_token: folderToken }) } })
  ensure(res, "bitable.app.create")

  const appToken = res.data?.app?.app_token
  if (!appToken) fail("No app_token returned")

  let tableId: string | undefined
  const tablesRes = await c.bitable.appTable.list({ path: { app_token: appToken } })
  if (tablesRes.code === 0 && tablesRes.data?.items?.length) {
    tableId = tablesRes.data.items![0]!.table_id ?? undefined
  }

  out({
    app_token: appToken,
    table_id: tableId,
    name: res.data?.app?.name,
    url: res.data?.app?.url,
    hint: tableId
      ? `Use app_token="${appToken}" and table_id="${tableId}" for other commands.`
      : `Use feishu-bitable get-meta to get table_id.`,
  })
}

async function cmdCreateField(args: string[]) {
  const [appToken, tableId, fieldName, fieldTypeStr, ...rest] = args
  if (!appToken || !tableId || !fieldName || !fieldTypeStr) {
    fail("Usage: create-field <app_token> <table_id> <field_name> <field_type> [--property json]")
  }
  const fieldType = parseInt(fieldTypeStr, 10)
  if (isNaN(fieldType)) fail("field_type must be a number")

  let property: Record<string, unknown> | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--property" && rest[i + 1]) property = JSON.parse(rest[++i]!) as Record<string, unknown>
  }

  const c = client()
  const res = await c.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: { field_name: fieldName, type: fieldType, ...(property && { property }) },
  })
  ensure(res, "bitable.appTableField.create")
  out({
    field_id: res.data?.field?.field_id,
    field_name: res.data?.field?.field_name,
    type: res.data?.field?.type,
    type_name: FIELD_TYPES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`,
  })
}

// ============ Help ============

function help() {
  console.log(`feishu-bitable — CLI for Feishu Bitable (multidimensional tables)

Auth (environment variables):
  FEISHU_APP_ID       Feishu app ID
  FEISHU_APP_SECRET   Feishu app secret
  FEISHU_DOMAIN       "feishu" (default) or "lark"

Commands:
  get-meta <url>
    Parse a Bitable URL and return app_token, table_id, table list.
    Supports /base/XXX and /wiki/XXX URLs.

  list-fields <app_token> <table_id>
    List all fields (columns) with types and properties.

  list-records <app_token> <table_id> [--page-size N] [--page-token T]
    List records (rows) with pagination. Default page size: 100.

  get-record <app_token> <table_id> <record_id>
    Get a single record by ID.

  create-record <app_token> <table_id> <fields_json>
    Create a new record. fields_json: JSON object of field name → value.
    Field value formats: Text="string", Number=123, SingleSelect="Option",
    MultiSelect=["A","B"], DateTime=timestamp_ms, User=[{id:"ou_xxx"}],
    URL={text:"Display",link:"https://..."}

  update-record <app_token> <table_id> <record_id> <fields_json>
    Update an existing record.

  create-app <name> [--folder-token T]
    Create a new Bitable application.

  create-field <app_token> <table_id> <field_name> <field_type> [--property json]
    Create a new field. field_type IDs:
    1=Text 2=Number 3=SingleSelect 4=MultiSelect 5=DateTime 7=Checkbox
    11=User 13=Phone 15=URL 17=Attachment 18=SingleLink 19=Lookup
    20=Formula 21=DuplexLink 22=Location 23=GroupChat
    1001=CreatedTime 1002=ModifiedTime 1003=CreatedUser
    1004=ModifiedUser 1005=AutoNumber

All output is JSON to stdout. Errors go to stderr with exit code 1.
`)
}

// ============ Main ============

const [, , cmd, ...rest] = process.argv

const commands: Record<string, (args: string[]) => Promise<void>> = {
  "get-meta": cmdGetMeta,
  "list-fields": cmdListFields,
  "list-records": cmdListRecords,
  "get-record": cmdGetRecord,
  "create-record": cmdCreateRecord,
  "update-record": cmdUpdateRecord,
  "create-app": cmdCreateApp,
  "create-field": cmdCreateField,
}

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  help()
  process.exit(0)
}

const handler = commands[cmd]
if (!handler) {
  console.error(`Unknown command: ${cmd}`)
  console.error(`Run feishu-bitable --help for usage.`)
  process.exit(1)
}

handler(rest).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
