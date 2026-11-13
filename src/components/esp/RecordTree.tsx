import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { sortChildren, type SortState } from "@/lib/esp/sort";
import { describeGroup, getDisplayName, getEditorId, hex8, type EspNode, type EspRecord } from "@/lib/esp/format";

const PAGE = 200;

interface Props {
  nodes: EspNode[];
  depth: number;
  expanded: Set<number>;
  selected: EspRecord | null;
  localized: boolean;
  /** How records inside each group are ordered; null keeps the file order. */
  sort: SortState | null;
  /** Changes whenever records are edited, added or removed, so a sorted group is ordered again. */
  version: number;
  onToggle: (uid: number) => void;
  onSelect: (r: EspRecord) => void;
}

/** Grid shared by the tree header and rows: FormID | EditorID | Name, like TES5Edit. */
export const TREE_COLS = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2";

export function RecordRow({
  record,
  depth,
  selected,
  localized,
  showType = false,
  onSelect,
}: {
  record: EspRecord;
  depth: number;
  selected: boolean;
  localized: boolean;
  /** Search results show the record type (WEAP, MISC...) so look-alikes are easy to tell apart. */
  showType?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(TREE_COLS, "w-full py-0.5 pr-2 text-left font-mono text-xs hover:bg-accent", selected && "bg-selected")}
    >
      <span className="truncate text-muted-foreground" style={{ paddingLeft: `${depth * 12 + 22}px` }}>
        {record.type === "TES4" ? "File Header" : showType ? `${record.type} ${hex8(record.formId)}` : hex8(record.formId)}
      </span>
      <span className="truncate">{getEditorId(record)}</span>
      <span className="truncate text-muted-foreground">
        {record.dirty && <span className="mr-1 text-modified">●</span>}
        {getDisplayName(record, localized)}
      </span>
    </button>
  );
}

export function RecordTree(props: Props) {
  const { nodes, depth, expanded, selected, localized, sort, version, onToggle, onSelect } = props;
  const [limit, setLimit] = useState(PAGE);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is how edits made in place are noticed
  const ordered = useMemo(() => (sort ? sortChildren(nodes, sort, localized) : nodes), [nodes, sort, localized, version]);

  return (
    <>
      {ordered.slice(0, limit).map((n) =>
        n.kind === "group" ? (
          <div key={n.uid}>
            <button
              onClick={() => onToggle(n.uid)}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-sm hover:bg-accent"
            >
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded.has(n.uid) && "rotate-90")} />
              <span className="truncate text-primary">{describeGroup(n)}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">{n.children.length}</span>
            </button>
            {expanded.has(n.uid) && <RecordTree {...props} nodes={n.children} depth={depth + 1} />}
          </div>
        ) : (
          <RecordRow
            key={n.uid}
            record={n}
            depth={depth}
            selected={selected === n}
            localized={localized}
            onSelect={() => onSelect(n)}
          />
        ),
      )}
      {ordered.length > limit && (
        <button
          onClick={() => setLimit(limit + PAGE)}
          style={{ paddingLeft: `${depth * 12 + 22}px` }}
          className="w-full py-1 text-left text-xs text-primary hover:underline"
        >
          Show more ({(ordered.length - limit).toLocaleString()} left)
        </button>
      )}
    </>
  );
}
