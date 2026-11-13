// A lane's workflow: what seori puts between /goal and the brief in the lane's kickoff. With the omp-ulw extension (a
// separate omp plugin, github.com/dbc-hbin/omp-ulw) "/goal <workflow> <keyword> <task>" sets omp's native goal and runs
// that workflow under it, so seori's startup verdict, pause and resume work unchanged. The keyword turns on the omp mode
// the workflow's own command (/mass-ulw and the like) would turn on; the bare commands run without a native goal, which
// is why seori never sends them. ulw-plan closes its goal once the reviewed plan is written, while the plan still awaits
// the owner's approval.

export const WORKFLOWS = ["ulw", "mass-ulw", "ulw-research", "ulw-plan", "ulw-loop", "ulw-execute"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

const KEYWORDS: Readonly<Record<Workflow, string | undefined>> = {
  ulw: undefined,
  "mass-ulw": "workflowz",
  "ulw-research": "workflowz",
  "ulw-plan": "ultrathink",
  "ulw-loop": "orchestrate",
  "ulw-execute": "orchestrate",
};

/** The words after /goal in the kickoff of a lane with this workflow: the workflow, then its keyword if it has one. */
export const workflowPrefix = (w: Workflow): string => (KEYWORDS[w] ? `${w} ${KEYWORDS[w]}` : w);

export const OMP_ULW_URL = "https://github.com/dbc-hbin/omp-ulw";

export const isWorkflow = (v: unknown): v is Workflow => WORKFLOWS.includes(v as Workflow);
