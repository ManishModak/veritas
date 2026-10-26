import fs from 'node:fs';
import path from 'node:path';
import {
  WorldModel,
  canonicalJson,
  externalId,
  sha256Hex,
  type Entity,
  type Relationship,
  type AuditEntry,
  type IngestObservation,
  type Provenance,
} from '../../vendor/world-model/src/index.ts';
import { caseId } from '../cases.ts';
import { RUNS } from '../paths.ts';
import type { CaseRun } from '../agent/types.ts';
import type { Evidence, EvidenceOrigin, EvidencePack } from '../agent/evidence.ts';

export interface WorldStoreOptions {
  directory?: string;
  clock?: () => Date;
}

export interface IngestResult {
  caseId: string;
  changed: boolean;
  processed: number;
  skippedUnchanged: number;
}

export interface ProvenanceResult {
  evidence: Evidence;
  origins: EvidenceOrigin;
  company: Entity;
  filings: Entity[];
  findings: Entity[];
  rulings: Entity[];
  relationships: Relationship[];
  audit: AuditEntry[];
}

interface CaseState {
  world: WorldModel;
  activeRevision: string;
  liveRevision?: string;
  revisions: Map<string, { learnedAt: string }>;
}

function sanitize<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'role' || k === 'enforcement') continue;
    out[k] = sanitize(v);
  }
  return out as T;
}

function isRecordedRun(id: string, run: CaseRun): boolean {
  try {
    const file = path.join(RUNS, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sha256Hex(canonicalJson(sanitize(recorded))) === sha256Hex(canonicalJson(sanitize(run)));
  } catch {
    return false;
  }
}

function buildFilingUrl(cik: number, accn: string, exactUrl?: string): string {
  if (exactUrl) return exactUrl;
  const rawAccn = accn.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${rawAccn}/${accn}-index.htm`;
}

export class WorldEvidenceStore {
  private worlds = new Map<string, CaseState>();
  private writes = new Map<string,Promise<unknown>>();
  private directory?: string;
  private clock: () => Date;

  constructor(options?: WorldStoreOptions) {
    this.directory = options?.directory;
    this.clock = options?.clock ?? (() => new Date());

    if (this.directory) {
      const worldDir = path.join(this.directory, '.world');
      if (fs.existsSync(worldDir)) {
        for (const file of fs.readdirSync(worldDir)) {
          if (file.endsWith('.json')) {
            const id = file.replace(/\.json$/, '');
            const world = new WorldModel({
              namespace: id,
              storage: 'local',
              directory: this.directory,
              clock: this.clock,
            });
            const company = world.view('graph').entity(externalId('company','cik',id.split('_')[0]));
            const activeRevision = (company?.attrs.activeRevision as string) ?? '';
            const liveRevision = company?.attrs.liveRevision as string | undefined;
            this.worlds.set(id, {
              world,
              activeRevision,
              liveRevision,
              revisions: new Map(world.view('graph').query({type:'revision'}).map(e=>[e.attrs.revisionId as string,{learnedAt:e.source.at}])),
            });
          }
        }
      }
    }
  }

  world(id: string): WorldModel {
    const state = this.worlds.get(id);
    if (!state) throw new Error(`Unknown case: ${id}`);
    return state.world;
  }

  async ingest(run: CaseRun, pack: EvidencePack): Promise<IngestResult> {
    const id=caseId(run.cik,run.fy_end);
    const next=(this.writes.get(id)??Promise.resolve()).then(()=>this.ingestCase(run,pack));
    this.writes.set(id,next.catch(()=>undefined));
    return next;
  }

  private async ingestCase(run: CaseRun, pack: EvidencePack): Promise<IngestResult> {
    const id = caseId(run.cik, run.fy_end);
    const sanitizedRun = sanitize(run);
    const sanitizedPack = sanitize(pack);
    if(canonicalJson(run.evidence)!==canonicalJson(pack.evidence)) throw new Error('Run evidence differs from the source-computed pack');
    const runChecksum = sha256Hex(canonicalJson({run:sanitizedRun,pack:sanitizedPack}));
    const revisionId = runChecksum.slice(0, 12);

    let state = this.worlds.get(id);
    if (!state) {
      const world = new WorldModel({
        namespace: id,
        storage: this.directory ? 'local' : 'memory',
        directory: this.directory,
        clock: this.clock,
      });
      state = {
        world,
        activeRevision: revisionId,
        revisions: new Map(),
      };
      this.worlds.set(id, state);
    }

    const isIdentical = state.revisions.has(revisionId);
    const learnedAt = state.revisions.get(revisionId)?.learnedAt ?? this.clock().toISOString();

    // Prepare observations for ingest pipeline
    const observations: IngestObservation[] = sanitizedPack.evidence.map((ev) => ({
      externalId: `${id}:${revisionId}:${ev.id}`,
      type: 'evidence',
      title: `${ev.id} (${ev.kind})`,
      text: ev.text,
      at: learnedAt,
      source: {
        kind: 'pipeline',
        by: 'evidence-pack',
        at: learnedAt,
        url: sanitizedPack.filing.url,
        runId: revisionId,
      },
      entities: [], // Company identity is explicitly CIK-keyed below, rather than inferred from a name.
    }));

    if (isIdentical) {
      // Replay all observations so an older revision cannot move the pipeline's staleness horizon backward.
      const replay: IngestObservation[]=state.world.view('graph').query({type:'evidence'}).filter(e=>e.id.startsWith('evidence:ingest:')).map(e=>({
        externalId:e.id.slice('evidence:ingest:'.length),type:'evidence',title:e.attrs.title as string,text:e.attrs.text as string,
        at:e.source.at,source:e.source,entities:[],
      }));
      const report = await state.world.ingest(replay);
      return {
        caseId: id,
        changed: false,
        processed: 0,
        skippedUnchanged: report.skippedUnchanged,
      };
    }

    // 1. Run pipeline ingest on observations
    const report = await state.world.ingest(observations);

    // 2. Upsert Company entity
    const filingDateIso = `${sanitizedPack.filing.filed}T00:00:00.000Z`;
    const companySource: Provenance = {
      kind: 'sec-edgar',
      by: 'sec',
      at: filingDateIso,
      url: sanitizedPack.filing.url,
      runId: revisionId,
    };
    const companyEntity = await state.world.upsertEntity({
      type: 'company',
      externalKey: { system: 'cik', id: String(sanitizedRun.cik) },
      name: sanitizedRun.company,
      attrs: {
        cik: sanitizedRun.cik,
        company: sanitizedRun.company,
        fy_end: sanitizedRun.fy_end,
        activeRevision: revisionId,
      },
      source: companySource,
    });

    // 3. Upsert Filing entities
    interface FilingInfo {
      accn: string;
      filed: string;
      url: string;
      form: string;
    }
    const filingMap = new Map<string, FilingInfo>();
    const registerFiling = (accn?: string, filed?: string, exactUrl?: string, form = '10-K') => {
      if (!accn) return;
      if (!filingMap.has(accn)) {
        const url = (accn === sanitizedPack.filing.accn && sanitizedPack.filing.url)
          ? sanitizedPack.filing.url
          : buildFilingUrl(sanitizedRun.cik, accn, exactUrl);
        filingMap.set(accn, {
          accn,
          filed: filed ?? sanitizedPack.filing.filed,
          url,
          form: accn === sanitizedPack.filing.accn ? (sanitizedPack.filing.form ?? '10-K') : form,
        });
      }
    };

    registerFiling(sanitizedPack.filing.accn, sanitizedPack.filing.filed, sanitizedPack.filing.url, sanitizedPack.filing.form);
    for (const ev of sanitizedPack.evidence) {
      const origin = sanitizedPack.origins[ev.id];
      if (!origin) continue;
      for (const row of origin.rows) {
        if (row.accn) registerFiling(row.accn, row.filed, undefined, row.form);
        if (row.rev_accn) registerFiling(row.rev_accn, row.rev_filed, undefined, '10-Q');
        if (row.ar_accn) registerFiling(row.ar_accn, row.ar_filed, undefined, '10-Q');
      }
    }

    const filingEntities = new Map<string, Entity>();
    for (const info of filingMap.values()) {
      const filingAt = `${info.filed}T00:00:00.000Z`;
      const filingSource: Provenance = {
        kind: 'sec-edgar',
        by: 'sec',
        at: filingAt,
        url: info.url,
        runId: revisionId,
      };
      const fe = await state.world.upsertEntity({
        type: 'filing',
        externalKey: { system: 'accn', id: info.accn },
        name: `${sanitizedRun.company} filing ${info.accn}`,
        attrs: {
          accn: info.accn,
          filed: info.filed,
          cik: sanitizedRun.cik,
          company: sanitizedRun.company,
          url: info.url,
          form: info.form,
        },
        source: filingSource,
      });
      filingEntities.set(info.accn, fe);

      // Connect company -> filing with unique stable context
      await state.world.relate({
        from: companyEntity.id,
        type: 'filed',
        to: fe.id,
        context: `ctx:comp_filing:${companyEntity.id}:${fe.id}`,
        source: filingSource,
      });
    }

    // 4. Upsert Evidence entities and connect filing -> evidence
    const evidenceEntities = new Map<string, Entity>();
    for (const ev of sanitizedPack.evidence) {
      const origin = sanitizedPack.origins[ev.id];
      const evAccns = new Set<string>();
      if (origin) {
        for (const row of origin.rows) {
          if (row.accn) evAccns.add(row.accn);
          if (row.rev_accn) evAccns.add(row.rev_accn);
          if (row.ar_accn) evAccns.add(row.ar_accn);
        }
      }
      if (evAccns.size === 0 && sanitizedPack.filing.accn) {
        evAccns.add(sanitizedPack.filing.accn);
      }

      // Preserve original fact accession/filed date
      let firstFiled = sanitizedPack.filing.filed;
      for (const a of evAccns) {
        const f = filingMap.get(a);
        if (f?.filed) { firstFiled = f.filed; break; }
      }
      const evAt = `${firstFiled}T00:00:00.000Z`;
      const evSource: Provenance = {
        kind: 'pipeline',
        by: 'evidence-pack',
        at: evAt,
        url: filingMap.get([...evAccns][0])?.url ?? sanitizedPack.filing.url,
        runId: revisionId,
      };

      const ee = await state.world.upsertEntity({
        type: 'evidence',
        externalKey: { system: `${id}:${revisionId}`, id: ev.id },
        name: `${ev.id}: ${ev.kind}`,
        attrs: {
          evidenceId: ev.id,
          kind: ev.kind,
          text: ev.text,
          source: ev.source,
          caseId: id,
          revisionId,
          origins: origin,
        },
        source: evSource,
      });
      evidenceEntities.set(ev.id, ee);

      // Connect filing -> evidence for all source filings
      for (const a of evAccns) {
        const fe = filingEntities.get(a);
        if (fe) {
          await state.world.relate({
            from: fe.id,
            type: 'supports',
            to: ee.id,
            context: `ctx:filing_ev:${fe.id}:${ee.id}`,
            source: evSource,
          });
        }
      }
    }

    // 5. Upsert Finding and Ruling entities
    const findingEntities = new Map<string, Entity>();
    for (const [sIdx, sample] of sanitizedRun.samples.entries()) {
      const sampleSource: Provenance = {
        kind: 'agent',
        by: sanitizedRun.model ?? 'nemotron',
        at: learnedAt,
        runId: revisionId,
      };

      // Upsert findings
      for (const [fIdx, finding] of sample.investigator.findings.entries()) {
        const fe = await state.world.upsertEntity({
          type: 'finding',
          externalKey: { system: `${id}:${revisionId}`, id: `s${sIdx}:f${fIdx}` },
          name: `${sanitizedRun.company} S${sIdx + 1} Finding ${fIdx + 1}`,
          attrs: {
            caseId: id,
            revisionId,
            sampleIndex: sIdx,
            findingIndex: fIdx,
            management_says: finding.management_says,
            numbers_show: finding.numbers_show,
            fit: finding.fit,
            evidence: finding.evidence,
            verdict: sample.investigator.verdict,
          },
          source: sampleSource,
        });
        findingEntities.set(`s${sIdx}:f${fIdx}`, fe);

        // Connect evidence -> finding
        for (const evId of finding.evidence) {
          const ee = evidenceEntities.get(evId);
          if (ee) {
            await state.world.relate({
              from: ee.id,
              type: 'supports',
              to: fe.id,
              context: `ctx:ev_finding:${ee.id}:${fe.id}`,
              source: sampleSource,
            });
          }
        }
      }

      // Upsert rulings and connect finding -> ruling via finding_index join
      for (const [rIdx, ruling] of sample.judge.rulings.entries()) {
        const rebuttal = sample.red_team.rebuttals.find((r) => r.finding_index === ruling.finding_index);
        const re = await state.world.upsertEntity({
          type: 'ruling',
          externalKey: { system: `${id}:${revisionId}`, id: `s${sIdx}:r${rIdx}` },
          name: `${sanitizedRun.company} S${sIdx + 1} Ruling ${rIdx + 1}`,
          attrs: {
            caseId: id,
            revisionId,
            sampleIndex: sIdx,
            rulingIndex: rIdx,
            finding_index: ruling.finding_index,
            ruling: ruling.ruling,
            reason: ruling.reason,
            evidence: ruling.evidence,
            rebuttal,
            final_verdict: sample.judge.final_verdict,
            confidence: sample.judge.confidence,
          },
          source: sampleSource,
        });

        // Join finding -> ruling
        const fe = findingEntities.get(`s${sIdx}:f${ruling.finding_index}`);
        if (fe) {
          await state.world.relate({
            from: fe.id,
            type: 'ruled',
            to: re.id,
            context: `ctx:finding_ruling:${fe.id}:${re.id}`,
            source: sampleSource,
          });
        }

        // Direct citation: evidence -> ruling
        for (const evId of ruling.evidence) {
          const ee = evidenceEntities.get(evId);
          if (ee) {
            await state.world.relate({
              from: ee.id,
              type: 'cites',
              to: re.id,
              context: `ctx:ev_ruling:${ee.id}:${re.id}`,
              source: sampleSource,
            });
          }
        }
      }
    }

    // Determine if this run is a live / changed run
    const isLive = Boolean(
      (run as unknown as { isLive?: boolean }).isLive ||
      (run as unknown as { live?: boolean }).live ||
      !isRecordedRun(id, run)
    );

    // Record revision in memory
    state.revisions.set(revisionId, { learnedAt });
    await state.world.upsertEntity({type:'revision',externalKey:{system:id,id:revisionId},attrs:{revisionId},source:{kind:'pipeline',at:learnedAt,runId:revisionId}});

    // Active revision logic: older recordings never overwrite live evidence on a read
    if (state.liveRevision && !isLive) {
      // Keep live revision active; do not overwrite with recording
    } else {
      state.activeRevision = revisionId;
      if (isLive) {
        state.liveRevision = revisionId;
      }
    }

    // Persist pointers through events; mutating a projected entity would be lost on replay.
    await state.world.upsertEntity({type:'company',externalKey:{system:'cik',id:String(run.cik)},name:run.company,
      attrs:{activeRevision:state.activeRevision,liveRevision:state.liveRevision??''},source:{kind:'pipeline',at:learnedAt,runId:revisionId}});

    return {
      caseId: id,
      changed: true,
      processed: report.processed,
      skippedUnchanged: report.skippedUnchanged,
    };
  }

  provenance(id: string, evidenceId: string): ProvenanceResult {
    const state = this.worlds.get(id);
    if (!state) throw new Error(`Unknown case: ${id}`);

    const graph = state.world.view('graph');
    const allEntities = graph.query({});

    const company = graph.entity(externalId('company','cik',id.split('_')[0]));
    if (!company) throw new Error(`Company entity not found for case: ${id}`);

    const revId = (company.attrs.activeRevision as string) || state.activeRevision;
    if (!revId) throw new Error(`No active revision for case: ${id}`);

    // Find the active evidence entity
    const evKey = externalId('evidence', `${id}:${revId}`, evidenceId);
    const evidenceEntity = allEntities.find((e) => e.id === evKey);
    if (!evidenceEntity) throw new Error(`Unknown evidence: ${evidenceId}`);

    const evidence: Evidence = {
      id: evidenceEntity.attrs.evidenceId as string,
      kind: evidenceEntity.attrs.kind as Evidence['kind'],
      text: evidenceEntity.attrs.text as string,
      source: evidenceEntity.attrs.source as string,
    };

    const origins = evidenceEntity.attrs.origins as EvidenceOrigin;

    // Collect all relationships from the store
    const rels = (state.world.stateShape() as {relationships:Relationship[]}).relationships.filter(r=>!r.validTo);

    // 1. Filings supporting this evidence: rel.from -> evidenceEntity.id
    const filingRels = rels.filter((r) => r.to === evidenceEntity.id && r.type === 'supports');
    const filingIds = new Set(filingRels.map((r) => r.from));
    const filings = allEntities.filter((e) => e.type === 'filing' && filingIds.has(e.id))
      .sort((a, b) => ((a.attrs.filed as string) ?? '').localeCompare((b.attrs.filed as string) ?? ''));

    // Company -> Filing relationships
    const compFilingRels = rels.filter((r) => r.from === company.id && filingIds.has(r.to));

    // 2. Findings citing this evidence: evidenceEntity.id -> finding
    const evFindingRels = rels.filter((r) => r.from === evidenceEntity.id && r.type === 'supports');
    const findingIds = new Set(evFindingRels.map((r) => r.to));
    const findings = allEntities
      .filter((e) => e.type === 'finding' && findingIds.has(e.id))
      .sort((a, b) => {
        const sa = (a.attrs.sampleIndex as number) ?? 0, sb = (b.attrs.sampleIndex as number) ?? 0;
        if (sa !== sb) return sa - sb;
        return ((a.attrs.findingIndex as number) ?? 0) - ((b.attrs.findingIndex as number) ?? 0);
      });

    // 3. Rulings connected to these findings or directly citing evidence
    const findingRulingRels = rels.filter((r) => findingIds.has(r.from) && r.type === 'ruled');
    const directRulingRels = rels.filter((r) => r.from === evidenceEntity.id && r.type === 'cites');
    const rulingIds = new Set([
      ...findingRulingRels.map((r) => r.to),
      ...directRulingRels.map((r) => r.to),
    ]);
    const rulings = allEntities
      .filter((e) => e.type === 'ruling' && rulingIds.has(e.id))
      .sort((a, b) => {
        const sa = (a.attrs.sampleIndex as number) ?? 0, sb = (b.attrs.sampleIndex as number) ?? 0;
        if (sa !== sb) return sa - sb;
        return ((a.attrs.rulingIndex as number) ?? 0) - ((b.attrs.rulingIndex as number) ?? 0);
      });

    const activeRelationships = [
      ...compFilingRels,
      ...filingRels,
      ...evFindingRels,
      ...findingRulingRels,
      ...directRulingRels,
    ];

    // Deduplicate relationships by id
    const uniqueRels = [...new Map(activeRelationships.map((r) => [r.id, r])).values()]
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      evidence,
      origins,
      company,
      filings,
      findings,
      rulings,
      relationships: uniqueRels,
      audit: [...state.world.audit()],
    };
  }
}
