import { Rpc } from "@opencode/plugin/rpc"

export interface Settings {
  address: string
  routing: boolean
}

export interface SettingsUpdate {
  address?: string
  routing?: boolean
}

const settingsSchema = {
  type: "object",
  properties: {
    address: { type: "string" },
    routing: { type: "boolean" },
  },
  required: ["address", "routing"],
  additionalProperties: false,
} as const

const emptyError = { type: "object", additionalProperties: false } as const

export const Ocpp = Rpc.define({
  id: "ocpp",
  methods: {
    get: {
      input: { type: "null" },
      output: settingsSchema,
    },
    update: {
      input: {
        type: "object",
        properties: {
          address: { type: "string" },
          routing: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: settingsSchema,
      errors: {
        invalid_address: emptyError,
        save_failed: emptyError,
      },
    },
    probe: {
      input: { type: "null" },
      output: {
        type: "object",
        properties: { reachable: { type: "boolean" } },
        required: ["reachable"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

export function readSettings(value: unknown): Settings {
  if (
    typeof value !== "object" ||
    value === null ||
    !("address" in value) ||
    typeof value.address !== "string" ||
    !("routing" in value) ||
    typeof value.routing !== "boolean"
  ) {
    throw new Error("Invalid proxy settings")
  }
  return { address: value.address, routing: value.routing }
}

export function readProbe(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("reachable" in value) ||
    typeof value.reachable !== "boolean"
  ) {
    throw new Error("Invalid proxy probe result")
  }
  return value.reachable
}
