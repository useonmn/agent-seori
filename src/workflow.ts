// A lane's workflow: the word seori puts between /goal and the brief in the lane's kickoff. With the omp-ulw extension
// (a separate omp plugin, github.com/dbc-hbin/omp-ulw) "/goal ulw <task>" still sets omp's native goal and also runs
// the lane as ULW, so seori's startup verdict, pause and resume work unchanged. omp-ulw's other entry points (mass-ulw,
// ulw-plan, ulw-research, ulw-execute, ulw-loop) run their own loop without a native goal, so seori cannot track a lane
// started with them; a brief may still ask a ulw lane to use those skills inside its work.

export const WORKFLOWS = ["ulw"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const OMP_ULW_URL = "https://github.com/dbc-hbin/omp-ulw";

export const isWorkflow = (v: unknown): v is Workflow => WORKFLOWS.includes(v as Workflow);
