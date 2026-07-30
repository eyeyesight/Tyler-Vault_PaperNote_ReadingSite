// T09 exposes two deep modules through one stable import path. The fixed-corpus
// loopback snapshot fixture remains independent of provider lifecycle code.
export {
  createSyntheticProjectSiteServer,
  normalizeBasePath,
} from "./pages-project-site-fixture.mjs"

export {
  PagesContractError,
  PagesProviderError,
  rollbackPagesDeployment,
  runBoundedPagesDeployment,
  safeReadback,
} from "./pages-provider-lifecycle.mjs"

export {
  deriveVerifiedSealedReleaseIdentity,
  loadVerifiedSealedRelease,
  loadVerifiedSealedReleaseForIdentity,
  verifiedSealedReleaseIdentity,
} from "./verified-sealed-release.mjs"
