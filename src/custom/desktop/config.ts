import type { CompactNode } from "./contracts";

interface Outbound { tag: string; type: string; outbounds?: string[]; default?: string }
export interface NodeConfig { nodes: CompactNode[]; group: string; selected: string }

// Input is formatted by the existing native formatter before reaching this adapter.
export function nodeConfig(content: string, preferred = ""): NodeConfig {
  const config = JSON.parse(content) as { outbounds?: Outbound[]; route?: { final?: string } };
  const outbounds = config.outbounds ?? [];
  const selectors = outbounds.filter((item) => item.type === "selector");
  const selector = selectors.find((item) => item.tag === config.route?.final) ?? selectors.find((item) => item.tag === "PROXY") ?? selectors[0];
  const candidates = outbounds.filter((item) => !["direct", "block", "dns", "selector", "urltest"].includes(item.type));
  const nodes = candidates.filter((item) => !selector || selector.outbounds?.includes(item.tag)).map((item) => ({ tag: item.tag, protocol: item.type }));
  if (!nodes.length || (!selector && nodes.length > 1)) throw new Error("订阅没有可选择的节点，请在高级管理中检查配置");
  const selected = nodes.some((item) => item.tag === preferred) ? preferred : nodes.some((item) => item.tag === selector?.default) ? selector!.default! : nodes[0].tag;
  return { nodes, group: selector?.tag ?? "", selected };
}

export function selectConfig(content: string, selected: string): string {
  const model = nodeConfig(content, selected);
  if (model.selected !== selected) throw new Error("节点已不存在，请重新选择");
  const config = JSON.parse(content) as { outbounds: Outbound[] };
  const selector = config.outbounds.find((item) => item.tag === model.group);
  if (selector) selector.default = selected;
  return JSON.stringify(config, null, 2);
}
