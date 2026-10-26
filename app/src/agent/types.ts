import type { Evidence } from './evidence.ts';

export interface Finding { management_says: string; numbers_show: string; fit: string; evidence: string[] }
export interface Investigator { verdict: string; summary: string; findings: Finding[]; questions_for_management: string[]; what_would_change_my_mind: string[] }
export interface Rebuttal { finding_index: number; innocent_explanation: string; evidence: string[]; support: string }
export interface RedTeam { rebuttals: Rebuttal[]; overall: string }
export interface Ruling { finding_index: number; ruling: string; reason: string; evidence: string[] }
export interface Judge { final_verdict: string; confidence: number; rulings: Ruling[]; deciding_evidence: string; evidence_that_would_settle_it: string[] }
export interface Grounding { citations: number; unknown_ids: string[]; uncited: number }
export interface Sample { investigator: Investigator; red_team: RedTeam; judge: Judge; grounding: Record<Stage, Grounding> }
export type Stage = 'investigator' | 'red_team' | 'judge';
export interface CaseRun {
  cik: number; company: string; fy_end: string; model: string; evidence: Evidence[];
  samples: Sample[]; agreement: Record<'investigator' | 'judge', Record<string, number>>;
}
export interface Progress { sample: number; total: number; stage: Stage; status: 'started' | 'completed' | 'retry'; attempt?: number; elapsedMs?: number }
