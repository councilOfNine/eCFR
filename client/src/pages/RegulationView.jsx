import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  FileText,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  BookOpen,
  Clock,
  List,
  X,
  Hash,
} from "lucide-react";

function CopyButton({ text, label = "Copy link" }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied!" : label}
    </button>
  );
}

function ContentSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-6 bg-muted rounded w-2/3" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-4 bg-muted rounded w-5/6" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-4 bg-muted rounded w-4/6" />
      <div className="h-6 bg-muted rounded w-1/2 mt-6" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-4 bg-muted rounded w-5/6" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-4 bg-muted rounded w-3/4" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-6 bg-muted rounded w-2/5 mt-6" />
      <div className="h-4 bg-muted rounded w-full" />
      <div className="h-4 bg-muted rounded w-4/5" />
    </div>
  );
}

function TocSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-4 bg-muted rounded" style={{ width: `${60 + Math.random() * 35}%` }} />
      ))}
    </div>
  );
}

function flattenParts(node) {
  const parts = [];
  function walk(n, parentSubchapter) {
    if (n.type === "part") {
      parts.push({ ...n, parentSubchapter });
      return;
    }
    const sub = n.type === "subchapter" ? n.identifier : parentSubchapter;
    for (const c of n.children || []) walk(c, sub);
  }
  walk(node, null);
  return parts;
}

function groupPartsBySubchapter(parts) {
  const groups = [];
  let current = null;
  for (const p of parts) {
    const key = p.parentSubchapter || "__none__";
    if (!current || current.key !== key) {
      current = { key, subchapter: p.parentSubchapter, parts: [] };
      groups.push(current);
    }
    current.parts.push(p);
  }
  return groups;
}

function TocSidebar({ structure, selectedPart, onSelectPart, titleNumber, chapter, agency }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set(["__all__"]));

  const allParts = useMemo(() => (structure ? flattenParts(structure) : []), [structure]);
  const groups = useMemo(() => groupPartsBySubchapter(allParts), [allParts]);

  function toggleGroup(key) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!structure) return <TocSkeleton />;

  return (
    <nav className="space-y-1">
      <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-3">
        {allParts.length} Parts
      </p>
      {groups.map((group) => {
        const isExpanded = expandedGroups.has(group.key) || expandedGroups.has("__all__");
        return (
          <div key={group.key}>
            {group.subchapter && (
              <button
                onClick={() => toggleGroup(group.key)}
                className="flex items-center gap-1.5 w-full text-left py-1.5 px-2 rounded text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                Subchapter {group.subchapter}
              </button>
            )}
            {isExpanded &&
              group.parts.map((p) => {
                const isSelected = selectedPart === p.identifier;
                const partLabel = p.label_description || p.label || `Part ${p.identifier}`;
                return (
                  <button
                    key={p.identifier}
                    onClick={() => onSelectPart(p.identifier)}
                    title={partLabel}
                    className={cn(
                      "block w-full text-left py-1.5 px-3 rounded text-xs transition-colors truncate",
                      group.subchapter && "ml-3",
                      isSelected
                        ? "bg-primary text-primary-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                  >
                    <span className="font-medium">Pt. {p.identifier}</span>
                    {p.reserved ? " [Reserved]" : ""}
                  </button>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}

function DiffView({ titleNumber, date, sections, part }) {
  const sectionIds = sections.map((s) => s.identifier).join(",");
  const { data, isLoading, error } = useQuery({
    queryKey: ["diff", titleNumber, date, sectionIds, part],
    queryFn: () => api.getRegulationDiff(titleNumber, { date, sections: sectionIds, part }),
    staleTime: 1000 * 60 * 10,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3 pl-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff...
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-destructive py-2 pl-4">Failed to load diff: {error.message}</p>;
  }

  if (!data?.diffs?.length) {
    return <p className="text-xs text-muted-foreground py-2 pl-4">No diff data available.</p>;
  }

  return (
    <div className="mt-2 space-y-3 pl-1">
      <p className="text-[10px] text-muted-foreground">
        Comparing {data.old_date} → {data.new_date}
      </p>
      {data.diffs.map((d, i) => (
        <div key={i} className="rounded border overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b text-xs">
            <span className="font-medium">§{d.section}</span>
            {d.status === "added" && <span className="text-green-600 font-medium">New section</span>}
            {d.status === "removed" && <span className="text-red-600 font-medium">Removed</span>}
            {d.status === "modified" && (
              <span className="text-muted-foreground">
                <span className="text-green-600">+{d.added}</span> <span className="text-red-600">-{d.removed}</span>
              </span>
            )}
            {d.status === "unchanged" && <span className="text-muted-foreground">No text changes</span>}
            {d.status === "not_found" && <span className="text-muted-foreground">Section not found in XML</span>}
          </div>
          {d.hunks?.length > 0 && (
            <div className="font-mono text-[11px] leading-5 overflow-x-auto">
              {d.hunks.map((hunk, hi) => (
                <div key={hi}>
                  {hi > 0 && (
                    <div className="px-3 py-1 text-muted-foreground bg-muted/30 text-center text-[10px]">···</div>
                  )}
                  {hunk.lines.map((line, li) => (
                    <div
                      key={li}
                      className={cn(
                        "px-3 py-0.5 whitespace-pre-wrap break-words border-l-2",
                        line.type === "add" &&
                          "bg-green-50 dark:bg-green-950/30 border-l-green-500 text-green-900 dark:text-green-300",
                        line.type === "remove" &&
                          "bg-red-50 dark:bg-red-950/30 border-l-red-500 text-red-900 dark:text-red-300",
                        line.type === "context" && "border-l-transparent text-muted-foreground",
                      )}
                    >
                      <span className="select-none opacity-50 mr-2 inline-block w-3 text-right">
                        {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
                      </span>
                      {line.text}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function VersionHistory({ titleNumber, chapter, part }) {
  const [expandedDate, setExpandedDate] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ["versions", titleNumber, chapter, part],
    queryFn: () => api.getRegulationVersions(titleNumber, { chapter, part }),
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading revision history...
      </div>
    );
  }

  if (!data || data.grouped_count === 0) {
    return <p className="text-sm text-muted-foreground py-4">No revision history available.</p>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground mb-3">
        {data.total_versions.toLocaleString()} section{data.total_versions !== 1 ? "s" : ""} amended across{" "}
        {data.grouped_count.toLocaleString()} date{data.grouped_count !== 1 ? "s" : ""}. Click a revision to view the
        diff.
      </p>
      <div className="space-y-0.5">
        {data.versions.map((v) => {
          const isExpanded = expandedDate === v.date;
          return (
            <div key={v.date} className={cn("rounded transition-colors", isExpanded && "bg-muted/30")}>
              <button
                onClick={() => setExpandedDate(isExpanded ? null : v.date)}
                className="flex items-start gap-3 py-2 px-2 rounded hover:bg-muted/50 text-sm w-full text-left"
              >
                <span className="shrink-0 pt-0.5">
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0 text-xs pt-0.5">{v.date}</span>
                <div className="min-w-0">
                  <span className="text-xs font-medium">
                    {v.sections.length} section{v.sections.length !== 1 ? "s" : ""} amended
                  </span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {v.sections.slice(0, 8).map((s, i) => (
                      <span
                        key={i}
                        className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded-full border",
                          s.removed
                            ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        §{s.identifier}
                        {s.removed ? " ✕" : ""}
                      </span>
                    ))}
                    {v.sections.length > 8 && (
                      <span className="text-[10px] text-muted-foreground">+{v.sections.length - 8} more</span>
                    )}
                  </div>
                </div>
              </button>
              {isExpanded && (
                <div className="pb-3 px-2">
                  <DiffView titleNumber={titleNumber} date={v.date} sections={v.sections} part={part} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data.grouped_count > 100 && (
        <p className="text-xs text-muted-foreground pt-2">Showing first 100 of {data.grouped_count} revision dates</p>
      )}
    </div>
  );
}

function PartContent({ titleNumber, chapter, subtitle, subchapter, part, agency }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["regulation-content", titleNumber, part],
    queryFn: () => api.getRegulationContent(titleNumber, { chapter, subtitle, subchapter, part, agency }),
    enabled: !!part,
    staleTime: 1000 * 60 * 10,
  });

  if (!part) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <BookOpen className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-lg font-medium">Select a part to view</p>
        <p className="text-sm mt-1">Choose a part from the table of contents to view its regulation text.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">Loading Part {part}...</p>
            <p className="text-xs text-muted-foreground">Fetching regulation content from eCFR</p>
          </div>
        </div>
        <ContentSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-destructive">
        <p className="font-medium">Failed to load Part {part}</p>
        <p className="text-sm text-muted-foreground mt-1">{error.message}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 pb-3 border-b">
        <div>
          <h2 className="text-lg font-semibold">{data.section_label}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            ~{data.word_count_estimate?.toLocaleString()} words • As of {data.title.date}
          </p>
        </div>
        <CopyButton text={window.location.href} />
      </div>
      <article
        className="regulation-content prose prose-sm max-w-none dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: data.content_html }}
      />
    </div>
  );
}

export default function RegulationView() {
  const { titleNumber } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const chapter = searchParams.get("chapter");
  const subtitle = searchParams.get("subtitle");
  const subchapter = searchParams.get("subchapter");
  const part = searchParams.get("part");
  const agency = searchParams.get("agency");

  const [activeTab, setActiveTab] = useState("content");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const { data: versionsData } = useQuery({
    queryKey: ["versions", titleNumber, chapter, part],
    queryFn: () => api.getRegulationVersions(titleNumber, { chapter, part }),
    enabled: !!part,
    staleTime: 1000 * 60 * 5,
  });

  const revisionCount = versionsData?.grouped_count || 0;

  const { data: structureData, isLoading: structureLoading } = useQuery({
    queryKey: ["regulation-structure", titleNumber, chapter, subtitle],
    queryFn: () => api.getRegulationStructure(titleNumber, { chapter, subtitle }),
    enabled: !!titleNumber,
    staleTime: 1000 * 60 * 10,
  });

  const allParts = useMemo(() => {
    if (!structureData?.structure) return [];
    return flattenParts(structureData.structure);
  }, [structureData]);

  useEffect(() => {
    if (!part && allParts.length > 0) {
      const first = allParts.find((p) => !p.reserved) || allParts[0];
      if (first) selectPart(first.identifier);
    }
  }, [allParts]);

  const currentPartInfo = useMemo(() => {
    if (!part || !allParts.length) return null;
    return allParts.find((p) => p.identifier === part);
  }, [part, allParts]);

  const currentPartIndex = useMemo(() => {
    if (!part || !allParts.length) return -1;
    return allParts.findIndex((p) => p.identifier === part);
  }, [part, allParts]);

  function selectPart(partId) {
    const next = new URLSearchParams(searchParams);
    if (partId) next.set("part", partId);
    else next.delete("part");
    setSearchParams(next);
    setActiveTab("content");
  }

  const ecfrUrl = `https://www.ecfr.gov/current/title-${titleNumber}${chapter ? "/chapter-" + chapter : ""}${part ? "/part-" + part : ""}`;

  const titleLabel = structureData ? `Title ${titleNumber}: ${structureData.title.name}` : `Title ${titleNumber}`;

  const chapterLabel = structureData?.structure?.label || (chapter ? `Chapter ${chapter}` : "");

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                {agency ? (
                  <Link
                    to={`/agency/${agency}`}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="h-3 w-3" /> Back to agency
                  </Link>
                ) : (
                  <Link
                    to="/"
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="h-3 w-3" /> Dashboard
                  </Link>
                )}
                <span className="text-xs text-muted-foreground">•</span>
                <span className="text-xs text-muted-foreground">{titleLabel}</span>
              </div>
              <h1 className="text-lg font-bold tracking-tight flex items-center gap-2 truncate">
                <FileText className="h-4 w-4 shrink-0" />
                {chapterLabel}
              </h1>
              {structureData && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {allParts.length} parts • As of {structureData.title.date}
                  {part && currentPartInfo && <span> • Viewing Part {part}</span>}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 pt-1">
              <button
                onClick={() => setSidebarOpen((s) => !s)}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors lg:hidden"
              >
                {sidebarOpen ? <X className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                TOC
              </button>
              <a
                href={ecfrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" /> eCFR.gov
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex-1 container mx-auto px-4 py-6 flex gap-6">
        {/* TOC Sidebar */}
        <aside className={cn("w-72 shrink-0 transition-all", sidebarOpen ? "block" : "hidden lg:block")}>
          <div className="sticky top-24 rounded-xl border bg-card shadow-sm overflow-hidden">
            <div className="p-4 border-b">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <List className="h-4 w-4" /> Table of Contents
              </h2>
            </div>
            <div className="p-3 max-h-[calc(100vh-12rem)] overflow-y-auto">
              {structureLoading ? (
                <TocSkeleton />
              ) : (
                <TocSidebar
                  structure={structureData?.structure}
                  selectedPart={part}
                  onSelectPart={selectPart}
                  titleNumber={titleNumber}
                  chapter={chapter}
                  agency={agency}
                />
              )}
            </div>
          </div>
        </aside>

        {/* Main content area */}
        <main className="flex-1 min-w-0">
          {/* Tab bar */}
          <div className="flex items-center gap-1 mb-4 border-b">
            <button
              onClick={() => setActiveTab("content")}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
                activeTab === "content"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <BookOpen className="h-3.5 w-3.5 inline mr-1.5" />
              Content
            </button>
            <button
              onClick={() => setActiveTab("versions")}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
                activeTab === "versions"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Clock className="h-3.5 w-3.5 inline mr-1.5" />
              Revisions
              {(versionsData?.total_versions || 0) > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary px-1.5 py-0 text-[10px] font-semibold min-w-[1.25rem] tabular-nums">
                  {versionsData.total_versions}
                </span>
              )}
            </button>
          </div>

          <div className="rounded-xl border bg-card shadow-sm p-6">
            {activeTab === "content" && (
              <>
                {revisionCount > 0 && (
                  <button
                    onClick={() => setActiveTab("versions")}
                    className="mb-4 w-full flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm text-left hover:bg-primary/10 transition-colors"
                  >
                    <Clock className="h-4 w-4 text-primary shrink-0" />
                    <span>
                      <span className="font-medium text-foreground">
                        {versionsData?.total_versions || 0} section
                        {(versionsData?.total_versions || 0) !== 1 ? "s" : ""} amended across {revisionCount} date
                        {revisionCount !== 1 ? "s" : ""}
                      </span>
                      <span className="text-muted-foreground"> — </span>
                      <span className="text-primary font-medium">view changes</span>
                    </span>
                  </button>
                )}
                <PartContent
                  titleNumber={titleNumber}
                  chapter={chapter}
                  subtitle={subtitle}
                  subchapter={subchapter}
                  part={part}
                  agency={agency}
                />
                {/* Part navigation */}
                {part && allParts.length > 1 && (
                  <div className="flex items-center justify-between mt-8 pt-4 border-t">
                    {currentPartIndex > 0 ? (
                      <button
                        onClick={() => selectPart(allParts[currentPartIndex - 1].identifier)}
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Part {allParts[currentPartIndex - 1].identifier}
                      </button>
                    ) : (
                      <span />
                    )}
                    <span className="text-xs text-muted-foreground">
                      Part {currentPartIndex + 1} of {allParts.length}
                    </span>
                    {currentPartIndex < allParts.length - 1 ? (
                      <button
                        onClick={() => selectPart(allParts[currentPartIndex + 1].identifier)}
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        Part {allParts[currentPartIndex + 1].identifier}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                )}
              </>
            )}

            {activeTab === "versions" && <VersionHistory titleNumber={titleNumber} chapter={chapter} part={part} />}
          </div>
        </main>
      </div>
    </div>
  );
}
