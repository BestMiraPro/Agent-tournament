export interface OpenCodeModelRef {
  providerID: string
  modelID: string
}

/**
 * OpenCode model IDs are `provider/model`, but the model half may itself contain
 * slashes (`wandb/deepseek-ai/DeepSeek-V4-Flash`). Split on the FIRST slash only —
 * a two-way split corrupts every W&B model. Verified against a live server.
 */
export function splitModelId(id: string): OpenCodeModelRef {
  const i = id.indexOf('/')
  if (i === -1) throw new Error(`splitModelId: "${id}" has no provider prefix`)
  const providerID = id.slice(0, i)
  const modelID = id.slice(i + 1)
  if (providerID.length === 0) throw new Error(`splitModelId: "${id}" has an empty provider`)
  if (modelID.length === 0) throw new Error(`splitModelId: "${id}" has an empty model`)
  return { providerID, modelID }
}

export function joinModelId(ref: OpenCodeModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}
