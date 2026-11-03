import { Router } from 'express';
import { z } from 'zod';
import {
  updateProjectStatus,
  getProjectFiles,
  getContractorAnswers,
  getPhase1Outputs,
  getProject,
} from '../services/supabase.js';
import { contractorKey } from '../otari/contractor-keys.js';
import { runCrossBeamFlow } from '../otari/runner.js';
import { extractPdfForProject } from '../services/extract.js';
import type { InternalFlowType } from '../utils/config.js';

export const generateRouter = Router();

const generateRequestSchema = z.object({
  project_id: z.string().uuid(),
  user_id: z.string().uuid(),
  flow_type: z.enum(['city-review', 'corrections-analysis', 'corrections-response']),
  simulate_guardrail_block: z.boolean().optional(),
});

generateRouter.post('/', async (req, res) => {
  console.log('Generate request received:', req.body);

  // Validate request
  const parseResult = generateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request', details: parseResult.error });
  }

  const { project_id, user_id, flow_type, simulate_guardrail_block } = parseResult.data;
  const simulateGuardrailBlock = simulate_guardrail_block ?? process.env.OTARI_SIMULATE_GUARDRAIL_BLOCK === 'true';

  // Respond immediately - processing continues async
  res.json({ status: 'processing', project_id });

  // Start async processing
  processGeneration(project_id, user_id, flow_type, simulateGuardrailBlock).catch((error) => {
    console.error('Generation failed:', error);
  });
});

async function processGeneration(
  projectId: string,
  userId: string,
  flowType: InternalFlowType,
  simulateGuardrailBlock: boolean,
) {
  const startTime = Date.now();

  try {
    console.log(`Starting generation for project ${projectId}, flow: ${flowType}`);

    // Get project details (city, address)
    const project = await getProject(projectId);
    const city = project.city || 'Unknown';
    const address = project.project_address || undefined;

    // Set initial processing status
    if (flowType === 'corrections-analysis') {
      await updateProjectStatus(projectId, 'processing-phase1');
    } else if (flowType === 'corrections-response') {
      await updateProjectStatus(projectId, 'processing-phase2');
    } else {
      await updateProjectStatus(projectId, 'processing');
    }

    // Pre-extract PDF → PNGs on Cloud Run (skips if archives already exist)
    if (flowType !== 'corrections-response') {
      try {
        await extractPdfForProject(projectId);
      } catch (extractErr) {
        // Non-fatal here: the runner reports it if the flow needs pages it doesn't have.
        console.warn('Pre-extraction failed:', extractErr);
      }
    }

    // Get the project's files (re-fetch to include any new archives)
    const fileRecords = await getProjectFiles(projectId);
    console.log(`Found ${fileRecords.length} project files`);

    if (fileRecords.length === 0) {
      throw new Error('No files found for project');
    }

    const files = fileRecords.map((r: { filename: string; storage_path: string; file_type: string }) => ({
      filename: r.filename,
      storage_path: r.storage_path,
      file_type: r.file_type,
    }));

    // For corrections-response: also need Phase 1 outputs + contractor answers
    let contractorAnswersJson: string | undefined;
    let phase1Artifacts: Record<string, unknown> | undefined;

    if (flowType === 'corrections-response') {
      const answers = await getContractorAnswers(projectId);
      contractorAnswersJson = JSON.stringify(answers, null, 2);
      const phase1 = await getPhase1Outputs(projectId);
      phase1Artifacts = phase1?.raw_artifacts as Record<string, unknown> | undefined;
    }

    // Required env vars
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');

    // Run the agent
    await runCrossBeamFlow({
      files,
      flowType,
      city,
      address,
      supabaseUrl,
      supabaseKey,
      projectId,
      userId,
      contractorAnswersJson,
      phase1Artifacts,
      simulateGuardrailBlock,
      apiKey: contractorKey(),
    });

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`Generation completed for project ${projectId} in ${duration} minutes`);
  } catch (error) {
    console.error(`Generation failed for project ${projectId}:`, error);
    try {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await updateProjectStatus(projectId, 'failed', msg);
    } catch (statusErr) {
      console.log('Could not update failed status');
    }
  }
}
