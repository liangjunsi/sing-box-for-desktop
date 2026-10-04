import { useState } from "react";

export function NodePicker({ nodes, selected, disabled, onSelect }: {
  nodes: { tag: string }[];
  selected: string;
  disabled: boolean;
  onSelect(tag: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const matches = nodes.filter((node) => node.tag.toLowerCase().includes((query ?? "").trim().toLowerCase()));
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const expanded = open && !disabled;
  function close() { setOpen(false); setQuery(null); setActive(0); }
  async function choose(tag: string) {
    close();
    await onSelect(tag);
  }
  return <div className="kc-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <input id="kc-search" role="combobox" aria-label="选择服务器节点" aria-autocomplete="list" aria-expanded={expanded} aria-controls="kc-node-options"
      aria-activedescendant={expanded && matches.length ? `kc-node-option-${index}` : undefined}
      autoComplete="off" placeholder={nodes.length ? "输入文字搜索节点" : "暂无节点，请更新订阅"}
      value={query ?? selected} disabled={disabled || !nodes.length}
      onFocus={() => { setOpen(true); setQuery(null); setActive(0); }}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          setActive(expanded ? Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))) : 0);
        }
        if (event.key === "Enter" && expanded && matches[index]) { event.preventDefault(); void choose(matches[index].tag); }
      }} />
    {expanded && <div className="kc-options" id="kc-node-options" role="listbox" aria-label="服务器节点">
      {matches.map((node, position) => <div id={`kc-node-option-${position}`} key={node.tag} role="option" aria-selected={node.tag === selected}
        className={position === index ? "kc-option-active" : ""} onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActive(position)} onClick={() => void choose(node.tag)}>{node.tag}{node.tag === selected && <span>✓</span>}</div>)}
      {!matches.length && <div className="kc-no-options">没有匹配的节点</div>}
    </div>}
  </div>;
}
