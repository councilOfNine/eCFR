import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Building2,
  FileText,
  Hash,
  Shield,
  Clock,
  Loader2,
  BookOpen,
  ChevronRight,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";

function formatNumber(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function CopyableChecksum({ value, label }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!value) return <span className="text-muted-foreground">Not computed</span>;

  async function handleCopy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-1">
      <button onClick={() => setExpanded((e) => !e)} className="text-left w-full">
        <span className="font-mono text-xs break-all">{expanded ? value : value.substring(0, 24) + "..."}</span>
      </button>
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied!" : "Copy checksum"}
      </button>
    </div>
  );
}

function InfoCard({ icon: Icon, label, value, mono, children }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      {children || <p className={cn("text-xl font-bold", mono && "font-mono text-sm break-all")}>{value}</p>}
    </div>
  );
}

function buildRegulationUrl(c, agencySlug) {
  const params = new URLSearchParams();
  if (c.chapter) params.set("chapter", c.chapter);
  if (c.subtitle) params.set("subtitle", c.subtitle);
  if (c.subchapter) params.set("subchapter", c.subchapter);
  if (c.part) params.set("part", c.part);
  if (agencySlug) params.set("agency", agencySlug);
  const qs = params.toString();
  return `/regulation/${c.title_number}${qs ? "?" + qs : ""}`;
}

function CfrContentTable({ content, agencySlug }) {
  if (!content || content.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No CFR content data yet. Run a full ingest to compute word counts.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="pb-3 pr-4 font-semibold">Title</th>
            <th className="pb-3 pr-4 font-semibold">Chapter/Subtitle</th>
            <th className="pb-3 pr-4 font-semibold text-right">Word Count</th>
            <th className="pb-3 pr-4 font-semibold text-right">Sections</th>
            <th className="pb-3 pr-4 font-semibold">Checksum</th>
            <th className="pb-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {content.map((c) => {
            const regUrl = buildRegulationUrl(c, agencySlug);
            return (
              <tr key={c.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                <td className="py-3 pr-4">
                  <Link to={regUrl} className="hover:underline font-medium text-primary">
                    Title {c.title_number}
                  </Link>
                  {c.title_name && <span className="block text-xs text-muted-foreground">{c.title_name}</span>}
                </td>
                <td className="py-3 pr-4 text-muted-foreground">
                  <Link to={regUrl} className="hover:underline">
                    {c.chapter ? `Ch. ${c.chapter}` : c.subtitle ? `Subtitle ${c.subtitle}` : "—"}
                    {c.subchapter && `, Subch. ${c.subchapter}`}
                    {c.part && `, Pt. ${c.part}`}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-right tabular-nums font-medium">{formatNumber(c.word_count)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{c.section_count || "—"}</td>
                <td className="py-3 pr-4 max-w-[200px]">
                  {c.checksum ? (
                    <CopyableChecksum value={c.checksum} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-3 text-right">
                  <Link
                    to={regUrl}
                    className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-xs"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTimeline({ history }) {
  if (!history || history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No historical data. Run multiple ingests over time to track changes.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {history.map((h, i) => (
        <div key={i} className="flex items-center gap-4 text-sm py-2 border-b last:border-0">
          <span className="text-muted-foreground w-28 shrink-0">{h.snapshot_date}</span>
          <span className="font-medium tabular-nums">{formatNumber(h.word_count)} words</span>
          <span className="font-mono text-xs text-muted-foreground truncate" title={h.checksum}>
            {h.checksum ? h.checksum.substring(0, 24) + "..." : "—"}
          </span>
          {i > 0 && history[i - 1].word_count !== h.word_count && (
            <span
              className={cn(
                "text-xs px-2 py-0.5 rounded-full",
                h.word_count > history[i - 1].word_count
                  ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
              )}
            >
              {h.word_count > history[i - 1].word_count ? "+" : ""}
              {formatNumber(h.word_count - history[i - 1].word_count)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SubAgencyList({ children }) {
  if (!children || children.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Building2 className="h-5 w-5" /> Sub-Agencies
        <span className="text-sm font-normal text-muted-foreground">({children.length})</span>
      </h2>
      <div className="space-y-1">
        {children.map((c) => (
          <Link
            key={c.slug}
            to={`/agency/${c.slug}`}
            className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors group"
          >
            <div>
              <span className="font-medium group-hover:underline">{c.name}</span>
              {c.short_name && <span className="ml-2 text-xs text-muted-foreground">({c.short_name})</span>}
            </div>
            <div className="flex items-center gap-3">
              {c.word_count > 0 && (
                <span className="text-sm text-muted-foreground tabular-nums">{formatNumber(c.word_count)} words</span>
              )}
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function AgencyDetail() {
  const { slug } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["agency", slug],
    queryFn: () => api.getAgency(slug),
    enabled: !!slug,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-lg text-destructive">Failed to load agency data</p>
          <Link to="/" className="text-primary hover:underline inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" /> Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const { agency, children, cfr_content, history } = data;
  const totalChildWords = children.reduce((sum, c) => sum + c.word_count, 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{agency.display_name || agency.name}</h1>
          {agency.short_name && <p className="text-sm text-muted-foreground">{agency.short_name}</p>}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <InfoCard icon={Hash} label="Word Count" value={formatNumber(agency.word_count)} />
          <InfoCard
            icon={Hash}
            label="Total (incl. sub-agencies)"
            value={formatNumber(agency.word_count + totalChildWords)}
          />
          <InfoCard icon={FileText} label="CFR References" value={agency.cfr_references?.length || 0} />
          <InfoCard icon={Shield} label="Checksum">
            <CopyableChecksum value={agency.checksum} />
          </InfoCard>
        </div>

        {agency.cfr_references?.length > 0 && (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <BookOpen className="h-5 w-5" /> CFR References
            </h2>
            <div className="flex flex-wrap gap-2">
              {agency.cfr_references.map((ref, i) => (
                <span
                  key={i}
                  className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium bg-secondary"
                >
                  Title {ref.title}
                  {ref.chapter && `, Ch. ${ref.chapter}`}
                  {ref.subtitle && `, Subtitle ${ref.subtitle}`}
                  {ref.subchapter && `, Subch. ${ref.subchapter}`}
                  {ref.part && `, Pt. ${ref.part}`}
                </span>
              ))}
            </div>
          </div>
        )}

        <SubAgencyList children={children} />

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <FileText className="h-5 w-5" /> Regulation Content Breakdown
          </h2>
          <CfrContentTable content={cfr_content} agencySlug={agency.slug} />
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5" /> Historical Changes
          </h2>
          <HistoryTimeline history={history} />
        </div>
      </main>
    </div>
  );
}
