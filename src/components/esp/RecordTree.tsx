import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeGroup, getEditorId, hex8, type EspNode, type EspRecord } from "@/lib/esp/format";

const PAGE = 200;

interface Props {
  nodes: EspNode[];
  depth: number;
  expanded: Set<number>;
  selected: EspRecord | null;
  onToggle: (uid: number) => void;
  onSelect: (r: EspRecord) => void;
}

export function RecordTree(props: Props) {
  const { nodes, depth, expanded, selected, onToggle, onSelect } = props;
  const [limit, setLimit] = useState(PAGE);
  const pad = { paddingLeft: `${depth * 14 + 8}px` };

  return (
    <>
      {nodes.slice(0, limit).map((n) =>
        n.kind === "group" ? (
          <div key={n.uid}>
            <button
              onClick={() => onToggle(n.uid)}
              style={pad}
              className="flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-accent"
            >
              <ChevronRight
                className={cn("size-3.5 shrink-0 transition-transform", expanded.has(n.uid) && "rotate-90")}
              />
              <span className="truncate font-medium">{describeGroup(n)}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">{n.children.length}</span>
            </button>
            {expanded.has(n.uid) && <RecordTree {...props} nodes={n.children} depth={depth + 1} />}
          </div>
        ) : (
          <button
            key={n.uid}
            onClick={() => onSelect(n)}
            style={{ paddingLeft: `${depth * 14 + 26}px` }}
            className={cn(
              "flex w-full gap-2 py-1 pr-2 text-left font-mono text-xs hover:bg-accent",
              selected === n && "bg-selected",
            )}
          >
            <span className="text-primary">{n.type}</span>
            <span className="text-muted-foreground">{hex8(n.formId)}</span>
            <span className="truncate">{getEditorId(n)}</span>
            {n.dirty && <span className="ml-auto text-modified">●</span>}
          </button>
        ),
      )}
      {nodes.length > limit && (
        <button
          onClick={() => setLimit(limit + PAGE)}
          style={{ paddingLeft: `${depth * 14 + 26}px` }}
          className="w-full py-1 text-left text-xs text-primary hover:underline"
        >
          Show more ({(nodes.length - limit).toLocaleString()} left)
        </button>
      )}
    </>
  );
}
