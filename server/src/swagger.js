import swaggerUi from "swagger-ui-express";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "eCFR Regulation Analyzer API",
    version: "1.0.0",
    description:
      "API for analyzing the electronic Code of Federal Regulations (eCFR). Provides endpoints for agency data, word counts, regulation content, revision history, and data ingestion.",
  },
  servers: [{ url: "/api", description: "Local development" }],
  tags: [
    { name: "Health", description: "Server health check" },
    { name: "Stats", description: "Overall statistics and ingest status" },
    { name: "Agencies", description: "Agency data and details" },
    { name: "Word Counts", description: "Precomputed word counts per agency" },
    { name: "Regulation", description: "Regulation content, structure, versions, and diffs" },
    { name: "Ingest", description: "Data ingestion triggers and status" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: {
          200: {
            description: "Server is healthy",
            content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "ok" } } } } },
          },
        },
      },
    },
    "/stats": {
      get: {
        tags: ["Stats"],
        summary: "Get overall statistics",
        description: "Returns aggregate stats including total agencies, titles, word counts, top agencies by word count, and current ingest status.",
        responses: {
          200: {
            description: "Statistics object",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total_agencies: { type: "integer" },
                    total_titles: { type: "integer" },
                    total_word_count: { type: "integer" },
                    top_agencies: { type: "array", items: { type: "object" } },
                    ingest_status: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agencies": {
      get: {
        tags: ["Agencies"],
        summary: "List all agencies",
        description: "Returns all top-level agencies with their word counts, children counts, and CFR references.",
        responses: {
          200: {
            description: "List of agencies",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agencies: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          slug: { type: "string" },
                          name: { type: "string" },
                          short_name: { type: "string" },
                          word_count: { type: "integer" },
                          children_count: { type: "integer" },
                          cfr_references: { type: "array" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agencies/{slug}": {
      get: {
        tags: ["Agencies"],
        summary: "Get agency details",
        description: "Returns detailed information for a specific agency including sub-agencies, CFR content breakdown, and historical snapshots.",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Agency slug identifier" },
        ],
        responses: {
          200: {
            description: "Agency detail object",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agency: { type: "object" },
                    children: { type: "array", items: { type: "object" } },
                    cfr_content: { type: "array", items: { type: "object" } },
                    history: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
          404: { description: "Agency not found" },
        },
      },
    },
    "/wordcounts": {
      get: {
        tags: ["Word Counts"],
        summary: "Get all agency word counts",
        description: "Returns precomputed word counts for all top-level agencies, including totals with sub-agency counts.",
        responses: {
          200: {
            description: "Word count data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total_word_count: { type: "integer" },
                    agency_count: { type: "integer" },
                    wordcounts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          slug: { type: "string" },
                          name: { type: "string" },
                          word_count: { type: "integer" },
                          total_word_count: { type: "integer" },
                          children_word_count: { type: "integer" },
                          children_count: { type: "integer" },
                          cfr_refs_count: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/wordcounts/compute": {
      post: {
        tags: ["Word Counts"],
        summary: "Recompute word counts",
        description: "Recomputes and stores word counts for all agencies from ingested CFR content.",
        responses: {
          200: {
            description: "Computation result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    agencies_with_counts: { type: "integer" },
                    total_word_count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/regulation/{titleNumber}/structure": {
      get: {
        tags: ["Regulation"],
        summary: "Get regulation structure (table of contents)",
        description: "Returns the hierarchical structure of a CFR title from the eCFR API. Can be filtered to a specific chapter.",
        parameters: [
          { name: "titleNumber", in: "path", required: true, schema: { type: "integer" }, description: "CFR title number (1-50)" },
          { name: "chapter", in: "query", schema: { type: "string" }, description: "Filter to a specific chapter (e.g. 'I')" },
          { name: "subtitle", in: "query", schema: { type: "string" }, description: "Filter to a specific subtitle (e.g. 'A')" },
        ],
        responses: {
          200: {
            description: "Structure tree",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "object", properties: { number: { type: "integer" }, name: { type: "string" }, date: { type: "string" } } },
                    structure: { type: "object", description: "Recursive tree with type, identifier, label, children" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/regulation/{titleNumber}/content": {
      get: {
        tags: ["Regulation"],
        summary: "Get regulation content for a specific part",
        description: "Fetches and renders the XML content of a specific CFR part as HTML. Uses eCFR's part-scoped API for fast loading.",
        parameters: [
          { name: "titleNumber", in: "path", required: true, schema: { type: "integer" }, description: "CFR title number" },
          { name: "part", in: "query", required: true, schema: { type: "string" }, description: "Part number (e.g. '1', '52')" },
          { name: "chapter", in: "query", schema: { type: "string" }, description: "Chapter identifier" },
          { name: "subtitle", in: "query", schema: { type: "string" }, description: "Subtitle identifier" },
          { name: "subchapter", in: "query", schema: { type: "string" }, description: "Subchapter identifier" },
          { name: "agency", in: "query", schema: { type: "string" }, description: "Agency slug for back-navigation context" },
        ],
        responses: {
          200: {
            description: "Rendered regulation content",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "object" },
                    section_label: { type: "string" },
                    agency: { type: "object", nullable: true },
                    content_html: { type: "string" },
                    part: { type: "string" },
                    word_count_estimate: { type: "integer" },
                  },
                },
              },
            },
          },
          400: { description: "Missing part parameter" },
          404: { description: "Part not found" },
        },
      },
    },
    "/regulation/{titleNumber}/versions": {
      get: {
        tags: ["Regulation"],
        summary: "Get revision history",
        description: "Returns the amendment history for a title, grouped by date. Filterable by chapter and part.",
        parameters: [
          { name: "titleNumber", in: "path", required: true, schema: { type: "integer" }, description: "CFR title number" },
          { name: "chapter", in: "query", schema: { type: "string" }, description: "Filter by chapter" },
          { name: "part", in: "query", schema: { type: "string" }, description: "Filter by part" },
        ],
        responses: {
          200: {
            description: "Version history",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title_number: { type: "integer" },
                    total_versions: { type: "integer" },
                    grouped_count: { type: "integer" },
                    versions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          date: { type: "string" },
                          amendment_date: { type: "string" },
                          sections: { type: "array", items: { type: "object" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/regulation/{titleNumber}/diff": {
      get: {
        tags: ["Regulation"],
        summary: "Get text diff between revisions",
        description: "Computes a line-level diff for specific sections between the day before and the amendment date. Uses LCS algorithm with collapsed context.",
        parameters: [
          { name: "titleNumber", in: "path", required: true, schema: { type: "integer" }, description: "CFR title number" },
          { name: "date", in: "query", required: true, schema: { type: "string", format: "date" }, description: "Amendment date (YYYY-MM-DD)" },
          { name: "sections", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated section identifiers (e.g. '1.7,1.3')" },
          { name: "part", in: "query", schema: { type: "string" }, description: "Part number (recommended for faster scoped fetches)" },
        ],
        responses: {
          200: {
            description: "Diff results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title_number: { type: "integer" },
                    old_date: { type: "string" },
                    new_date: { type: "string" },
                    diffs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          section: { type: "string" },
                          status: { type: "string", enum: ["added", "removed", "modified", "unchanged", "not_found"] },
                          added: { type: "integer" },
                          removed: { type: "integer" },
                          hunks: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                lines: {
                                  type: "array",
                                  items: {
                                    type: "object",
                                    properties: {
                                      type: { type: "string", enum: ["add", "remove", "context"] },
                                      text: { type: "string" },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ingest/quick": {
      post: {
        tags: ["Ingest"],
        summary: "Trigger quick ingest",
        description: "Fetches agencies and titles from eCFR and stores them in the database. Does not download CFR content XML.",
        responses: {
          200: { description: "Ingest started" },
          409: { description: "Ingestion already in progress" },
        },
      },
    },
    "/ingest/full": {
      post: {
        tags: ["Ingest"],
        summary: "Trigger full ingest",
        description: "Fetches agencies, titles, and all CFR content XML. Computes word counts and checksums. May take several minutes.",
        responses: {
          200: { description: "Ingest started (runs in background)" },
          409: { description: "Ingestion already in progress" },
        },
      },
    },
    "/ingest/status": {
      get: {
        tags: ["Ingest"],
        summary: "Get ingest status",
        description: "Returns current ingestion status including progress and any errors.",
        responses: {
          200: {
            description: "Ingest status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    status: { type: "string", enum: ["idle", "running", "completed", "failed"] },
                    started_at: { type: "string", nullable: true },
                    completed_at: { type: "string", nullable: true },
                    error: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function setupSwagger(app) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: "eCFR API Documentation",
    customCss: ".swagger-ui .topbar { display: none }",
  }));
}
