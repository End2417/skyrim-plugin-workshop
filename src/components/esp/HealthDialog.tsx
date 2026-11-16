import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HeartPulse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { checkEsl } from "@/lib/esp/esl";
import { getEditorId, hex8, type EspFile, type EspRecord } from "@/lib/esp/format";
import { HEADER_FLAG_ESL, setHeaderFlag } from "@/lib/esp/header";
import type { History } from "@/lib/esp/history";
import { scanHealth, type HealthReport } from "@/lib/esp/health";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  history: History;
  onGoTo: (r: EspRecord) => void;
  /** Called after the file was changed (the ESL flag), so the editor can refresh. */
  onApplied: () => void;
}

export function HealthDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it always looks at the plugin as it is now. */}
        <Form {...props} />
      </DialogContent>
    </Dialog>
  );
}

const SHOWN = 15;

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-md border p-3">
      <h3 className="font-medium">
        {title}
        {count !== undefined && <span className="ml-2 text-xs font-normal text-muted-foreground">{count.toLocaleString()}</span>}
      </h3>
      {children}
    </section>
  );
}

function RecordLine({ r, onGoTo }: { r: EspRecord; onGoTo: (r: EspRecord) => void }) {
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {r.type} {hex8(r.formId)} {getEditorId(r) ?? ""}
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onGoTo(r)}>
        Go to
      </Button>
    </li>
  );
}

function Form({ file, history, onGoTo, onApplied, onOpenChange }: Props) {
  const cancelled = useRef(false);
  const esl = useMemo(() => checkEsl(file), [file]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState(esl?.flagged ?? false);
  const [more, setMore] = useState<Record<string, number>>({});

  useEffect(() => {
    cancelled.current = false;
    scanHealth(file, () => cancelled.current)
      .then((r) => {
        if (r && !cancelled.current) setReport(r);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled.current = true;
    };
  }, [file]);

  const go = (r: EspRecord) => {
    onGoTo(r);
    onOpenChange(false);
  };
  const limit = (key: string) => more[key] ?? SHOWN;
  const showMore = (key: string) => setMore((m) => ({ ...m, [key]: (m[key] ?? SHOWN) + 50 }));

  function flagAsLight() {
    history.batch("Set ESL flag", () => setHeaderFlag(file, HEADER_FLAG_ESL, true));
    setFlagged(true);
    onApplied();
  }

  const clean = report && report.duplicateEditorIds.length === 0 && report.duplicateFormIds.length === 0 && report.orphanGroups.length === 0 && report.unreferenced.length === 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HeartPulse className="size-5" /> Plugin health
        </DialogTitle>
        <DialogDescription>
          Whether <span className="font-mono">{file.name}</span> can be a light plugin, and duplicates and orphans inside it. For missing masters and broken references use Check plugin.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        {esl && (
          <Section title="Light plugin (ESL)">
            {esl.eligible ? (
              <p>
                Yes. {esl.newRecords === 0 ? "It adds no records of its own" : `All ${esl.newRecords.toLocaleString()} new records have IDs between ${esl.windowMin.toString(16).toUpperCase()} and ${esl.windowMax.toString(16).toUpperCase()}`}.
                {flagged && " It is flagged as light."}
              </p>
            ) : (
              <>
                <p className="text-destructive">No. {esl.reasons[0]}</p>
                <p className="text-xs text-muted-foreground">
                  Renumbering the IDs changes every reference to them, which the editor cannot do safely. xEdit's "Compact FormIDs for ESL" does it.
                </p>
                <ul className="divide-y">
                  {esl.outside.slice(0, limit("esl")).map((r) => (
                    <RecordLine key={r.uid} r={r} onGoTo={go} />
                  ))}
                </ul>
                {esl.outside.length > limit("esl") && (
                  <Button variant="ghost" size="sm" onClick={() => showMore("esl")}>
                    Show more
                  </Button>
                )}
              </>
            )}
            {esl.reasons.length > 0 && esl.eligible && <p className="text-xs text-muted-foreground">{esl.reasons[0]}</p>}
            {esl.eligible && !flagged && esl.newRecords > 0 && (
              <Button size="sm" variant="secondary" onClick={flagAsLight}>
                Flag as light plugin
              </Button>
            )}
          </Section>
        )}

        {!report && !error && <p className="text-muted-foreground">Looking through the records…</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        {report && (
          <>
            <Section title="Same Editor ID" count={report.duplicateEditorIds.length}>
              {report.duplicateEditorIds.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-2">
                  {report.duplicateEditorIds.slice(0, limit("edid")).map((d) => (
                    <li key={d.key}>
                      <p className="font-mono text-xs">{d.key}</p>
                      <ul className="divide-y pl-2">
                        {d.records.map((r) => (
                          <RecordLine key={r.uid} r={r} onGoTo={go} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              {report.duplicateEditorIds.length > limit("edid") && (
                <Button variant="ghost" size="sm" onClick={() => showMore("edid")}>
                  Show more
                </Button>
              )}
            </Section>

            <Section title="Same FormID" count={report.duplicateFormIds.length}>
              {report.duplicateFormIds.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-2">
                  {report.duplicateFormIds.slice(0, limit("fid")).map((d) => (
                    <li key={d.key}>
                      <p className="font-mono text-xs">{d.key}</p>
                      <ul className="divide-y pl-2">
                        {d.records.map((r) => (
                          <RecordLine key={r.uid} r={r} onGoTo={go} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Groups whose parent record is missing" count={report.orphanGroups.length}>
              {report.orphanGroups.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="divide-y">
                  {report.orphanGroups.slice(0, limit("grp")).map((o) => (
                    <li key={o.group.uid} className="py-1 font-mono text-xs">
                      {o.kind}: parent {hex8(o.parentId)} is not in this file ({o.group.children.length} entries)
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="New records nothing else in this plugin points at" count={report.unreferenced.length}>
              <p className="text-xs text-muted-foreground">
                Only supporting types are listed (shouts, textures, projectiles, lists...). They may still be used from a script or another plugin.
                {report.unreadable > 0 && ` ${report.unreadable.toLocaleString()} records of types the editor has no layout for could not be read, so they may be using some of these.`}
              </p>
              {report.unreferenced.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="divide-y">
                  {report.unreferenced.slice(0, limit("unref")).map((r) => (
                    <RecordLine key={r.uid} r={r} onGoTo={go} />
                  ))}
                </ul>
              )}
              {report.unreferenced.length > limit("unref") && (
                <Button variant="ghost" size="sm" onClick={() => showMore("unref")}>
                  Show more
                </Button>
              )}
            </Section>
            {clean && <p className="text-muted-foreground">Nothing to report in {report.scanned.toLocaleString()} records.</p>}
          </>
        )}
      </div>
    </>
  );
}
