export type CallPurpose = 'judge' | 'reflect' | 'criteria'

export interface CompleteRequest {
  purpose: CallPurpose
  prompt: string
  modelId: string
}

export interface Provider {
  complete(req: CompleteRequest): Promise<string>
}
