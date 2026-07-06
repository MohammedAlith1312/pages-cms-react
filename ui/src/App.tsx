import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { useSession } from "@/lib/auth-client";
import { Providers } from "@/components/providers";
import { useUser } from "@/contexts/user-context";
import { useConfig } from "@/contexts/config-context";
import { hasGithubIdentity } from "@/lib/authz-shared";
import { getSchemaByName } from "@/lib/schema";
import { isConfigEnabled } from "@/lib/config";
import { getVisits } from "@/lib/tracker";

// Page / Component imports
import { SignIn } from "@/components/sign-in";
import { InviteSignIn } from "@/components/invite-sign-in";
import { RepoSelect } from "@/components/repo/repo-select";
import { RepoLatest } from "@/components/repo/repo-latest";
import { RepoTemplates } from "@/components/repo/repo-templates";
import { Collection } from "@/components/collection/collection";
import { Entry } from "@/components/entry/entry";
import { Collaborators } from "@/components/collaborators";
import { ActionsPage } from "@/components/actions/actions-page";
import { CachePage } from "@/components/cache/cache-page";
import { RepoLayout } from "@/components/repo/repo-layout";
import { RepoProvider } from "@/contexts/repo-context";
import { ConfigProvider } from "@/contexts/config-context";
import { MediaView } from "@/components/media/media-view";
import { DocumentTitle, formatRepoBranchTitle } from "@/components/document-title";
import { Loader } from "@/components/loader";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Profile } from "@/components/settings/profile";
import { Identities } from "@/components/settings/identities";
import { Installations } from "@/components/settings/installations";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { BookText, ArrowLeft } from "lucide-react";

// ── APP SESSION WRAPPER ──────────────────────────────────────────────────────
function SessionLoader() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadUser() {
      try {
        const res = await fetch("/api/users/me");
        if (res.ok) {
          const payload = await res.json();
          if (active) {
            setUser(payload.data || null);
          }
        }
      } catch (err) {
        console.error("Failed to load detailed user profile:", err);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    loadUser();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader />
      </div>
    );
  }

  return (
    <Providers user={user}>
      <Outlet />
    </Providers>
  );
}

function AppWrapper() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader />
      </div>
    );
  }

  const isAuthRoute = location.pathname.startsWith("/sign-in");

  if (!session?.user && !isAuthRoute) {
    return <Navigate to="/sign-in" replace />;
  }

  if (session?.user && isAuthRoute) {
    return <Navigate to="/" replace />;
  }

  return <SessionLoader />;
}

// ── PROJECTS LANDING PAGE ────────────────────────────────────────────────────
function ProjectsPage() {
  const [defaultAccount, setDefaultAccount] = useState<any>(null);
  const [hasRecentVisits, setHasRecentVisits] = useState(false);
  const { user } = useUser();
  const isGithubUser = hasGithubIdentity(user);

  useEffect(() => {
    setHasRecentVisits(getVisits().length > 0);
  }, []);

  if (!user) return null;

  return (
    <div className="max-w-screen-sm mx-auto p-4 md:p-6 space-y-8">
      {user.accounts && user.accounts.length > 0 ? (
        <div className="min-h-[calc(100vh-12rem)] flex flex-col justify-center space-y-8">
          {hasRecentVisits && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium tracking-tight">
                Recently visited
              </h2>
              <RepoLatest />
            </div>
          )}
          <div className="space-y-4">
            <h2 className="text-lg font-medium tracking-tight">
              Open a project
            </h2>
            <RepoSelect
              onAccountSelect={(account) => setDefaultAccount(account)}
            />
          </div>
          {/* {isGithubUser && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium tracking-tight">
                Create from a template
              </h2>
              <RepoTemplates defaultAccount={defaultAccount} />
            </div>
          )} */}
        </div>
      ) : isGithubUser ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <div>
            <h2 className="text-lg font-semibold mb-2">Install the GitHub App</h2>
            <p className="text-muted-foreground mb-4">Install the GitHub App on at least one account before you can open or create projects.</p>
            <a
              href="/api/github-app/install"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Install GitHub App
            </a>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <div>
            <h2 className="text-lg font-semibold mb-2">No repositories yet</h2>
            <p className="text-muted-foreground">You need an invitation to a repository before you can collaborate. Ask a repository owner to invite you.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── REPOSITORY WORKSPACE WRAPPER ─────────────────────────────────────────────
function RepoWrapper() {
  const { owner, repo, branch } = useParams();
  // undefined = still loading, null = loaded but no .pages.yml, object = loaded config
  const [config, setConfig] = useState<any>(undefined);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadRepoData() {
      if (!owner || !repo) return;
      setLoading(true);
      setError(null);
      setConfig(undefined); // reset to "loading" state on each fetch
      try {
        const repoRes = await fetch(`/api/repos/${owner}/${repo}`);
        if (!repoRes.ok) {
          throw new Error("Failed to fetch repository details.");
        }
        const repoData = await repoRes.json();

        const branchList = repoData.data?.branches || [];
        const targetBranch = branch || repoData.data?.defaultBranch || "main";

        const configRes = await fetch(`/api/${owner}/${repo}/${encodeURIComponent(targetBranch)}/config`);
        const configData = await configRes.json();

        if (active) {
          setBranches(branchList);
          // null means "config loaded but no .pages.yml found"
          setConfig(configData.data ?? null);
        }
      } catch (err: any) {
        console.error(err);
        if (active) setError(err.message || "Failed to load repository.");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadRepoData();
    return () => {
      active = false;
    };
  }, [owner, repo, branch]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-destructive font-medium">{error}</p>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  const targetBranch = branch || branches[0] || "main";

  return (
    <RepoProvider repo={{ owner: owner!, repo: repo!, branch: targetBranch, branches } as any}>
      <ConfigProvider value={config ?? null}>
        <RepoLayout>
          <Outlet />
        </RepoLayout>
      </ConfigProvider>
    </RepoProvider>
  );
}

// ── REPOSITORY MAIN REDIRECT ──────────────────────────────────────────────────
function RepoBranchRoot() {
  const { config } = useConfig();
  const { owner, repo, branch } = useParams();
  const { user } = useUser();
  const navigate = useNavigate();

  useEffect(() => {
    // undefined = still loading, wait for it
    if (config === undefined) return;

    // null = config loaded but no .pages.yml → go to /configuration to set it up
    if (config === null) {
      navigate(
        `/${owner}/${repo}/${encodeURIComponent(branch || "main")}/configuration`,
        { replace: true }
      );
      return;
    }

    // config loaded → redirect to first content collection
    if (config?.object?.content?.[0]) {
      navigate(
        `/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/${config.object.content[0].type}/${encodeURIComponent(config.object.content[0].name)}`,
        { replace: true }
      );
    } else if (config?.object?.media?.[0]) {
      navigate(
        `/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/media/${encodeURIComponent(config.object.media[0].name)}`,
        { replace: true }
      );
    } else {
      // No content or media defined → always fall back to /configuration
      navigate(
        `/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/configuration`,
        { replace: true }
      );
    }
  }, [config, navigate, owner, repo, branch, user]);

  // Show spinner while waiting for the redirect to happen
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader />
    </div>
  );
}

// ── COLLECTION ROUTE WRAPPERS ────────────────────────────────────────────────
function CollectionRouteWrapper() {
  const { name } = useParams();
  const decodedName = decodeURIComponent(name || "");
  return <Collection name={decodedName} />;
}

function EntryRouteWrapper() {
  const { name, "*": wild } = useParams();
  const decodedName = decodeURIComponent(name || "");
  const decodedPath = wild ? decodeURIComponent(wild) : "";
  return <Entry name={decodedName} path={decodedPath} />;
}

function SingleFileRouteWrapper() {
  const { name } = useParams();
  const { config } = useConfig();
  const decodedName = decodeURIComponent(name || "");
  const schema = getSchemaByName(config?.object, decodedName);
  if (!schema) return <div className="p-4 text-destructive">Schema not found.</div>;
  return <Entry name={decodedName} path={schema.path} title={schema.label || schema.name} />;
}

function MediaRouteWrapper() {
  const { name } = useParams();
  const [searchParams] = useSearchParams();
  const decodedName = decodeURIComponent(name || "");
  const path = searchParams.get("path") || "";
  return (
    <div className="max-w-screen-xl mx-auto flex-1 flex flex-col h-full">
      <div className="flex flex-col relative flex-1">
        <MediaView initialPath={path} media={decodedName} />
      </div>
    </div>
  );
}

function CollaboratorsRouteWrapper() {
  const { owner, repo, branch } = useParams();
  return <Collaborators owner={owner!} repo={repo!} branch={branch} />;
}

function ActionsRouteWrapper() {
  const { owner, repo, branch } = useParams();
  return <ActionsPage owner={owner!} repo={repo!} branch={branch!} />;
}

function CacheRouteWrapper() {
  const { owner, repo, branch } = useParams();
  return <CachePage owner={owner!} repo={repo!} branch={branch!} />;
}

// ── SETTINGS VIEW WRAPPER ────────────────────────────────────────────────────
function SettingsPage() {
  const { user } = useUser();
  if (!user) return <Navigate to="/sign-in" replace />;

  const githubConnected = hasGithubIdentity(user);
  const githubManageUrl = "https://github.com/settings/installations";

  return (
    <div className="max-w-screen-sm mx-auto p-4 md:p-6 space-y-6">
      <Button asChild variant="outline" size="xs" className="inline-flex">
        <a href="/">
          <ArrowLeft className="mr-2 size-4" />
          Go home
        </a>
      </Button>
      <header className="flex items-center mb-6">
        <h1 className="font-semibold tracking-tight text-lg md:text-2xl">
          Settings
        </h1>
      </header>
      <div className="flex flex-col relative flex-1 space-y-6">
        <Profile
          name={user.name}
          email={user.email}
          githubUsername={user.githubUsername}
        />

        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>
              Your sign-in methods and linked identity providers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Identities
              email={user.email}
              githubConnected={githubConnected}
              githubUsername={user.githubUsername}
              githubManageUrl={githubManageUrl}
            />
          </CardContent>
        </Card>

        {githubConnected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base md:text-lg">
                Installations
              </CardTitle>
              <CardDescription>
                Manage the accounts the Github application is installed on.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Installations />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── REPOSITORY CONFIGURATION WRAPPER ─────────────────────────────────────────
function NoConfigScreen() {
  const { owner, repo, branch } = useParams();
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const targetBranch = branch || "main";
      const response = await fetch(
        `/api/${owner}/${repo}/${encodeURIComponent(targetBranch)}/files/${encodeURIComponent(".pages.yml")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "settings", content: "" }),
        }
      );
      if (!response.ok) throw new Error("Failed to create configuration file.");
      navigate(`/${owner}/${repo}/${encodeURIComponent(targetBranch)}/configuration?empty-created`);
      window.location.reload();
    } catch (err) {
      setIsCreating(false);
      console.error(err);
    }
  };

  return (
    <div className="absolute inset-0 p-4 md:p-6 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <h2 className="text-xl font-semibold">No configuration file</h2>
        <p className="text-muted-foreground text-sm">
          You need to add a &ldquo;.pages.yml&rdquo; file to this branch.
        </p>
        <Button onClick={handleCreate} disabled={isCreating} className="mt-2">
          {isCreating ? "Creating..." : "Create a configuration file"}
        </Button>
      </div>
    </div>
  );
}

function ConfigurationPage() {
  const { config, setConfig } = useConfig();
  const { user } = useUser();

  const handleSave = async (data: Record<string, any>) => {
    setConfig(data.config);
  };

  if (!hasGithubIdentity(user)) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-muted-foreground">Only GitHub users can manage repository configuration.</p>
      </div>
    );
  }

  // No .pages.yml exists yet — show creation prompt
  if (config === null) {
    return <NoConfigScreen />;
  }

  return (
    <>
      {config && (
        <DocumentTitle
          title={formatRepoBranchTitle("Configuration", config.owner, config.repo, config.branch)}
        />
      )}
      <Entry
        path=".pages.yml"
        onSave={handleSave}
        title="Configuration"
        headerMeta={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground"
              >
                <a
                  href="https://pagescms.org/docs/configuration/"
                  target="_blank"
                  rel="noreferrer"
                >
                  <BookText />
                  <span className="sr-only">Configuration docs</span>
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>View docs</TooltipContent>
          </Tooltip>
        }
      />
    </>
  );
}

// ── COLLABORATOR INVITE SIGN-IN WRAPPER ──────────────────────────────────────
function CollaboratorSignInWrapper() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  return <InviteSignIn token={token} />;
}

// ── MAIN ROUTING MATRIX ──────────────────────────────────────────────────────
function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="pages-cms-theme">
      <BrowserRouter>
        <Routes>
          {/* Main session wrapper */}
          <Route element={<AppWrapper />}>
            {/* Authenticated routes without repo layout */}
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/settings" element={<SettingsPage />} />

            {/* Repository Workspace routes (requires layout) */}
            <Route path="/:owner/:repo" element={<RepoWrapper />}>
              {/* Redirect to default branch loaded by wrapper */}
              <Route index element={<RepoBranchRoot />} />
              <Route path=":branch" element={<RepoBranchRoot />} />
              <Route path=":branch/collection/:name" element={<CollectionRouteWrapper />} />
              <Route path=":branch/collection/:name/new" element={<EntryRouteWrapper />} />
              <Route path=":branch/collection/:name/edit/*" element={<EntryRouteWrapper />} />
              <Route path=":branch/file/:name" element={<SingleFileRouteWrapper />} />
              <Route path=":branch/media/:name" element={<MediaRouteWrapper />} />
              <Route path=":branch/collaborators" element={<CollaboratorsRouteWrapper />} />
              <Route path=":branch/actions" element={<ActionsRouteWrapper />} />
              <Route path=":branch/cache" element={<CacheRouteWrapper />} />
              <Route path=":branch/configuration" element={<ConfigurationPage />} />
            </Route>
          </Route>

          {/* Auth routes */}
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/sign-in/collaborator" element={<CollaboratorSignInWrapper />} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}

export default App;
