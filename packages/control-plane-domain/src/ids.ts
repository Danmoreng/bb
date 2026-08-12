import { z } from "zod";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProjectControlId = Brand<string, "ProjectControlId">;
export type AgentRoleId = Brand<string, "AgentRoleId">;
export type TaskRefId = Brand<string, "TaskRefId">;
export type RunRefId = Brand<string, "RunRefId">;
export type DecisionRefId = Brand<string, "DecisionRefId">;
export type ArtifactRefId = Brand<string, "ArtifactRefId">;

export const projectControlIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"ProjectControlId">();
export const agentRoleIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"AgentRoleId">();
export const taskRefIdSchema = z.string().trim().min(1).brand<"TaskRefId">();
export const runRefIdSchema = z.string().trim().min(1).brand<"RunRefId">();
export const decisionRefIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"DecisionRefId">();
export const artifactRefIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"ArtifactRefId">();

export interface IdGenerator {
  next(prefix: string): string;
}
