import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export type ProjectStatus =
  | 'ready' | 'uploading' | 'processing' | 'processing-phase1'
  | 'awaiting-answers' | 'processing-phase2' | 'completed' | 'failed';

export type MessageRole = 'system' | 'assistant' | 'tool';

export async function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
  errorMessage?: string,
): Promise<void> {
  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (errorMessage !== undefined) {
    updateData.error_message = errorMessage;
  }

  const { error } = await supabase
    .schema('crossbeam')
    .from('projects')
    .update(updateData)
    .eq('id', projectId);

  if (error) {
    console.error('Failed to update project status:', error);
    throw error;
  }
}

/** The project's `[OTARI_TELEMETRY]` message bodies, oldest first. */
export async function getTelemetryMessages(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .schema('crossbeam')
    .from('messages')
    .select('content')
    .eq('project_id', projectId)
    .like('content', '[OTARI_TELEMETRY]%')
    .order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: { content: string }) => row.content);
}

export async function getProject(projectId: string) {
  const { data, error } = await supabase
    .schema('crossbeam')
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();

  if (error) {
    console.error('Failed to get project:', error);
    throw error;
  }
  return data;
}

export async function getProjectFiles(projectId: string) {
  const { data, error } = await supabase
    .schema('crossbeam')
    .from('files')
    .select('*')
    .eq('project_id', projectId);

  if (error) {
    console.error('Failed to get project files:', error);
    throw error;
  }
  return data || [];
}

export async function getContractorAnswers(projectId: string) {
  const { data, error } = await supabase
    .schema('crossbeam')
    .from('contractor_answers')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to get contractor answers:', error);
    throw error;
  }
  return data || [];
}

export async function getPhase1Outputs(projectId: string) {
  const { data, error } = await supabase
    .schema('crossbeam')
    .from('outputs')
    .select('*')
    .eq('project_id', projectId)
    .eq('flow_phase', 'analysis')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error('Failed to get Phase 1 outputs:', error);
    throw error;
  }
  return data;
}

export async function insertMessage(
  projectId: string,
  role: MessageRole,
  content: string,
): Promise<void> {
  const { error } = await supabase
    .schema('crossbeam')
    .from('messages')
    .insert({ project_id: projectId, role, content });

  if (error) {
    console.error('Failed to insert message:', error);
    // Don't throw - message logging shouldn't break the generation flow
  }
}

export async function downloadProjectFile(storagePath: string): Promise<Buffer> {
  // A storage_path may carry its bucket as a prefix; otherwise it is in the uploads bucket.
  const knownBucket = ['crossbeam-demo-assets', 'crossbeam-uploads'].find((name) => storagePath.startsWith(`${name}/`));
  const bucket = knownBucket ?? 'crossbeam-uploads';
  const objectPath = knownBucket ? storagePath.slice(knownBucket.length + 1) : storagePath;

  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error || !data) {
    throw new Error(`Download failed for ${storagePath}: ${error?.message ?? 'no data'}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Inserts an output row with the next version number for this project and phase. */
export async function createOutputRecord(
  projectId: string,
  flowPhase: string,
  data: Record<string, unknown>,
): Promise<string> {
  const { data: existing, error: versionError } = await supabase
    .schema('crossbeam')
    .from('outputs')
    .select('version')
    .eq('project_id', projectId)
    .eq('flow_phase', flowPhase)
    .order('version', { ascending: false })
    .limit(1);
  if (versionError) throw versionError;

  const { data: inserted, error } = await supabase
    .schema('crossbeam')
    .from('outputs')
    .insert({
      project_id: projectId,
      flow_phase: flowPhase,
      version: (existing?.[0]?.version ?? 0) + 1,
      ...data,
    })
    .select('id')
    .single();
  if (error) {
    console.error('Failed to create output record:', error);
    throw error;
  }
  return inserted.id;
}

export interface ContractorQuestionRow {
  project_id: string;
  question_key: string;
  question_text: string;
  question_type: string;
  options: string[] | null;
  context: string | null;
  correction_item_id: string | null;
  is_answered: false;
}

/** Replaces unanswered questions and links the new ones to their output version. */
export async function replaceContractorQuestions(
  projectId: string,
  rows: ContractorQuestionRow[],
  outputId: string,
): Promise<void> {
  const { error: deleteError } = await supabase
    .schema('crossbeam')
    .from('contractor_answers')
    .delete()
    .eq('project_id', projectId)
    .eq('is_answered', false);
  if (deleteError) console.error('Failed to delete old unanswered questions:', deleteError);

  if (rows.length === 0) return;

  const { error } = await supabase
    .schema('crossbeam')
    .from('contractor_answers')
    .insert(rows.map((row) => ({ ...row, output_id: outputId })));
  if (error) {
    console.error('Failed to insert contractor questions:', error);
    throw error;
  }
}
