// Most module-integration tests exercise ahead-of-gate routes deliberately.
// Production code is fail-closed when HOSTED_SURFACE is absent, so this test
// adapter opts those suites into the advanced surface explicitly.
import worker from "../src/index";

export * from "../src/index";

const healthyDeletionLedger = {
  async head() {
    return null;
  },
};

function advancedEnv(env: unknown, authenticateLegacyFixture = false): never {
  const routed: Record<string, unknown> = {
    ...(env as object),
    HOSTED_SURFACE: "advanced",
  };
  const suppliesBodies = typeof env === "object" && env !== null && "BODIES" in env;
  if (authenticateLegacyFixture && !suppliesBodies) {
    routed.BODIES = healthyDeletionLedger;
  }
  return routed as never;
}

const advancedWorker = {
  ...worker,
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return worker.fetch(request, advancedEnv(env, true), ctx);
  },
  scheduled(controller: ScheduledController, env: unknown, ctx: ExecutionContext) {
    return worker.scheduled(controller, advancedEnv(env), ctx);
  },
  queue(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext) {
    return worker.queue(batch, advancedEnv(env), ctx);
  },
} as typeof worker;

export default advancedWorker;
