export type ConnectorJson =
  | null
  | boolean
  | number
  | string
  | ConnectorJson[]
  | { [key: string]: ConnectorJson };
export type ConnectorAuth =
  { kind: "managed" } | { kind: "custom"; scheme: string };
