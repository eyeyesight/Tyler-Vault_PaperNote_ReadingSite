// Local Pages contract only. Provider lifecycle and sealed-release custody live at
// their own public boundaries; this façade intentionally exposes no deploy authority.
export {
  createSyntheticProjectSiteServer,
  normalizeBasePath,
} from "./pages-project-site-fixture.mjs"
