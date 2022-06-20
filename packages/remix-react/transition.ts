// TODO: We eventually might not want to import anything directly from `history`
// and leverage `react-router` here instead
import { Action } from "history";
import type { Location } from "history";
import { tsConstructSignatureDeclaration } from "@babel/types";

import type { DeferredRouteData, RouteData } from "./routeData";
import type { RouteMatch } from "./routeMatching";
import type { ClientRoute } from "./routes";
import { matchClientRoutes } from "./routeMatching";
import invariant from "./invariant";

////////////////////////////////////////////////////////////////////////////////
//#region Types and Utils
////////////////////////////////////////////////////////////////////////////////

export class DeferredResponse {
  constructor(public response: Response) {}
}

const DEFERRED_PROMISE_PREFIX = "__deferred_promise:";

export async function parseDataFromDeferredReadableStream(
  body: ReadableStream<Uint8Array> | null | undefined
) {
  if (!body) {
    return { initialData: undefined, deferred: {} };
  }

  let reader = body.getReader();

  let buffer: Uint8Array[] = [];
  let sections: string[] = [];
  let closed = false;
  let readStreamSection = async () => {
    if (sections.length > 0) return sections.shift();

    let encoder = new TextEncoder();
    let decoder = new TextDecoder();

    while (!closed && sections.length === 0) {
      let chunk = await reader.read();
      if (chunk.done) {
        closed = true;
        break;
      }
      buffer.push(chunk.value);

      try {
        let bufferedString = decoder.decode(mergeArrays(...buffer));
        let splitSections = bufferedString.split("\n\n", 2);
        if (splitSections.length === 2) {
          sections.push(splitSections[0]);
          buffer = [encoder.encode(splitSections[1])];
        }

        if (sections.length > 0) {
          break;
        }
      } catch {
        continue;
      }
    }

    if (sections.length > 0) {
      return sections.shift();
    }

    if (buffer.length > 0) {
      let bufferedString = decoder.decode(mergeArrays(...buffer));
      sections = bufferedString.split("\n\n");
      buffer = [];
    }

    return sections.shift();
  };

  let deferred: Record<string, Promise<unknown>> = {};
  let deferredResolvers: Record<string, (data: unknown) => void> = {};

  let readTheRestOfTheResponse = async () => {
    for (
      let section = await readStreamSection();
      section;
      section = await readStreamSection()
    ) {
      let [event, ...sectionDataStrings] = section.split(":");
      let sectionDataString = sectionDataStrings.join(":");

      let data = JSON.parse(sectionDataString);
      if (event === "data") {
        for (let [key, value] of Object.entries(data)) {
          if (deferredResolvers[key]) {
            deferredResolvers[key](value);
            delete deferredResolvers[key];
          }
        }
      } else if (event === "error") {
        for (let [key, value] of Object.entries(data) as Iterable<
          [string, { message: string; stack?: string }]
        >) {
          let err = new Error(value.message);
          err.stack = value.stack;
          if (deferredResolvers[key]) {
            deferredResolvers[key](err);
            delete deferredResolvers[key];
          }
        }
      }
    }

    // Reject any existing deferred promises as we are done with the response
    for (let [key, resolver] of Object.entries(deferredResolvers)) {
      delete deferredResolvers[key];
      resolver(new Error("Response stream ended."));
    }
  };

  let initialSection = await readStreamSection();
  if (!initialSection) throw new Error("No initial deferred data found.");
  let initialData = JSON.parse(initialSection);

  // Setup deferred data and resolvers for later
  if (typeof initialData === "object" && initialData !== null) {
    for (let [eventKey, value] of Object.entries(initialData)) {
      if (
        typeof value !== "string" ||
        !value.startsWith(DEFERRED_PROMISE_PREFIX)
      ) {
        continue;
      }

      deferred[eventKey] = new Promise<any>((resolve) => {
        deferredResolvers[eventKey] = (value: unknown) => {
          resolve(value);
          delete deferredResolvers[eventKey];
        };
      });
    }
  }

  readTheRestOfTheResponse().catch((error: unknown) => {
    // Reject any existing deferred promises if something blows up
    for (let [key, resolver] of Object.entries(deferredResolvers)) {
      resolver(error);
      delete deferredResolvers[key];
    }
  });

  return { initialData, deferred };
}

function mergeArrays(...arrays: Uint8Array[]) {
  let out = new Uint8Array(
    arrays.reduce((total, arr) => total + arr.length, 0)
  );
  let offset = 0;
  for (let arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export interface CatchData<T = any> {
  status: number;
  statusText: string;
  data: T;
}

export interface TransitionManagerState {
  /**
   * The current location the user sees in the browser, during a transition this
   * is the "old page"
   */
  location: Location;

  /**
   * The current set of route matches the user sees in the browser. During a
   * transition this are the "old matches"
   */
  matches: ClientMatch[];

  /**
   * Only used When both navigation and fetch loads are pending, the fetch loads
   * may need to use the next matches to load data.
   */
  nextMatches?: ClientMatch[];

  /**
   * Data from the loaders that user sees in the browser. During a transition
   * this is the "old" data, unless there are multiple pending forms, in which
   * case this may be updated as fresh data loads complete
   */
  loaderData: RouteData;

  /**
   * Deferred data from the loaders that user sees in the browser. During a transition
   * this is the "old" data, unless there are multiple pending forms, in which
   * case this may be updated as fresh data loads complete
   */
  deferredLoaderData: DeferredRouteData;

  /**
   * Holds the action data for the latest NormalPostSubmission
   */
  actionData?: RouteData;

  /**
   * Tracks the latest, non-keyed pending submission
   */
  transition: Transition;

  /**
   * Persists thrown response loader/action data. TODO: should probably be an array
   * and keep track of them all and pass the array to ErrorBoundary.
   */
  catch?: CatchData;

  /**
   * Persists uncaught loader/action errors. TODO: should probably be an array
   * and keep track of them all and pass the array to ErrorBoundary.
   */
  error?: Error;

  /**
   * The id of the nested ErrorBoundary in which to render the error.
   *
   * - undefined: no error
   * - null: error, but no routes have a boundary, use a default
   * - string: actual id
   */
  errorBoundaryId: null | string;

  /**
   * The id of the nested ErrorBoundary in which to render the error.
   *
   * - undefined: no error
   * - null: error, but no routes have a boundary, use a default
   * - string: actual id
   */
  catchBoundaryId: null | string;

  fetchers: Map<string, Fetcher>;
}

export interface TransitionManagerInit {
  routes: ClientRoute[];
  location: Location;
  loaderData: RouteData;
  deferredLoaderData: DeferredRouteData;
  actionData?: RouteData;
  catch?: CatchData;
  error?: Error;
  catchBoundaryId?: null | string;
  errorBoundaryId?: null | string;
  onChange: (state: TransitionManagerState) => void;
  onRedirect: (to: string, state?: any) => void;
}

export interface Submission {
  action: string;
  method: string;
  formData: FormData;
  encType: string;
  key: string;
}

export interface ActionSubmission extends Submission {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
}

export interface LoaderSubmission extends Submission {
  method: "GET";
}

export type TransitionStates = {
  Idle: {
    state: "idle";
    type: "idle";
    submission: undefined;
    location: undefined;
  };
  SubmittingAction: {
    state: "submitting";
    type: "actionSubmission";
    submission: ActionSubmission;
    location: Location;
  };
  SubmittingLoader: {
    state: "submitting";
    type: "loaderSubmission";
    submission: LoaderSubmission;
    location: Location;
  };
  LoadingLoaderSubmissionRedirect: {
    state: "loading";
    type: "loaderSubmissionRedirect";
    submission: LoaderSubmission;
    location: Location;
  };
  LoadingAction: {
    state: "loading";
    type: "actionReload";
    submission: ActionSubmission;
    location: Location;
  };
  LoadingActionRedirect: {
    state: "loading";
    type: "actionRedirect";
    submission: ActionSubmission;
    location: Location;
  };
  LoadingFetchActionRedirect: {
    state: "loading";
    type: "fetchActionRedirect";
    submission: undefined;
    location: Location;
  };
  LoadingRedirect: {
    state: "loading";
    type: "normalRedirect";
    submission: undefined;
    location: Location;
  };
  Loading: {
    state: "loading";
    type: "normalLoad";
    location: Location;
    submission: undefined;
  };
};

export type Transition = TransitionStates[keyof TransitionStates];

export type Redirects = {
  Loader: {
    isRedirect: true;
    type: "loader";
    setCookie: boolean;
  };
  Action: {
    isRedirect: true;
    type: "action";
    setCookie: boolean;
  };
  LoaderSubmission: {
    isRedirect: true;
    type: "loaderSubmission";
    setCookie: boolean;
  };
  FetchAction: {
    isRedirect: true;
    type: "fetchAction";
    setCookie: boolean;
  };
};

// TODO: keep data around on resubmission?
type FetcherStates<TData = any> = {
  Idle: {
    state: "idle";
    type: "init";
    submission: undefined;
    data: undefined;
  };
  SubmittingAction: {
    state: "submitting";
    type: "actionSubmission";
    submission: ActionSubmission;
    data: undefined;
  };
  SubmittingLoader: {
    state: "submitting";
    type: "loaderSubmission";
    submission: LoaderSubmission;
    data: TData | undefined;
  };
  ReloadingAction: {
    state: "loading";
    type: "actionReload";
    submission: ActionSubmission;
    data: TData;
  };
  LoadingActionRedirect: {
    state: "loading";
    type: "actionRedirect";
    submission: ActionSubmission;
    data: undefined;
  };
  Loading: {
    state: "loading";
    type: "normalLoad";
    submission: undefined;
    data: TData | undefined;
  };
  Done: {
    state: "idle";
    type: "done";
    submission: undefined;
    data: TData;
  };
};

export type Fetcher<TData = any> =
  FetcherStates<TData>[keyof FetcherStates<TData>];

type ClientMatch = RouteMatch<ClientRoute>;

type DataResult = {
  match: ClientMatch;
  value: TransitionRedirect | Error | any;
  deferred?: Record<string, Promise<unknown>>;
};

type DataRedirectResult = {
  match: ClientMatch;
  value: TransitionRedirect;
};

type DataErrorResult = {
  match: ClientMatch;
  value: Error;
};

type DataCatchResult = {
  match: ClientMatch;
  value: CatchValue;
};

export class CatchValue {
  constructor(
    public status: number,
    public statusText: string,
    public data: any
  ) {}
}

export type NavigationEvent = {
  type: "navigation";
  action: Action;
  location: Location;
  submission?: Submission;
};

export type FetcherEvent = {
  type: "fetcher";
  key: string;
  submission?: Submission;
  href: string;
};

export type DataEvent = NavigationEvent | FetcherEvent;

function isActionSubmission(
  submission: Submission
): submission is ActionSubmission {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(submission.method);
}

function isLoaderSubmission(
  submission: Submission
): submission is LoaderSubmission {
  return submission.method === "GET";
}

interface _Location extends Location {
  state: {
    isRedirect: boolean;
    type: string;
  } | null;
}

interface RedirectLocation extends _Location {
  state: {
    isRedirect: true;
    type: string;
    setCookie: boolean;
  };
}

function isRedirectLocation(location: Location): location is RedirectLocation {
  return (
    Boolean(location.state) && (location as RedirectLocation).state.isRedirect
  );
}

interface LoaderRedirectLocation extends RedirectLocation {
  state: {
    isRedirect: true;
    type: "loader";
    setCookie: boolean;
  };
}

function isLoaderRedirectLocation(
  location: Location
): location is LoaderRedirectLocation {
  return isRedirectLocation(location) && location.state.type === "loader";
}

interface ActionRedirectLocation extends RedirectLocation {
  state: {
    isRedirect: true;
    type: "action";
    setCookie: boolean;
  };
}

function isActionRedirectLocation(
  location: Location
): location is ActionRedirectLocation {
  return isRedirectLocation(location) && location.state.type === "action";
}

interface FetchActionRedirectLocation extends RedirectLocation {
  state: {
    isRedirect: true;
    type: "fetchAction";
    setCookie: boolean;
  };
}

function isFetchActionRedirect(
  location: Location
): location is FetchActionRedirectLocation {
  return isRedirectLocation(location) && location.state.type === "fetchAction";
}

interface LoaderSubmissionRedirectLocation extends RedirectLocation {
  state: {
    isRedirect: true;
    type: "loaderSubmission";
    setCookie: boolean;
  };
}

function isLoaderSubmissionRedirectLocation(
  location: Location
): location is LoaderSubmissionRedirectLocation {
  return (
    isRedirectLocation(location) && location.state.type === "loaderSubmission"
  );
}

export class TransitionRedirect {
  location: string;
  constructor(location: Location | string, public setCookie: boolean) {
    this.location =
      typeof location === "string"
        ? location
        : location.pathname + location.search;
  }
}

export const IDLE_TRANSITION: TransitionStates["Idle"] = {
  state: "idle",
  submission: undefined,
  location: undefined,
  type: "idle",
};

export const IDLE_FETCHER: FetcherStates["Idle"] = {
  state: "idle",
  type: "init",
  data: undefined,
  submission: undefined,
};
//#endregion

////////////////////////////////////////////////////////////////////////////////
//#region createTransitionManager
////////////////////////////////////////////////////////////////////////////////
export function createTransitionManager(init: TransitionManagerInit) {
  let { routes } = init;

  let pendingNavigationController: AbortController | undefined;
  let pendingNavigationDeferredControllers: Map<string, AbortController> =
    new Map();
  let cancelledDeferredRouteIds: Set<string> = new Set();
  let fetchControllers = new Map<string, AbortController>();
  let incrementingLoadId = 0;
  let navigationLoadId = -1;
  let fetchReloadIds = new Map<string, number>();
  let fetchRedirectIds = new Set<string>();

  let matches = matchClientRoutes(routes, init.location);

  if (!matches) {
    // If we do not match a user-provided-route, fall back to the root
    // to allow the CatchBoundary to take over
    matches = [
      {
        params: {},
        pathname: "",
        route: routes[0],
      },
    ];
  }

  let state: TransitionManagerState = {
    location: init.location,
    loaderData: init.loaderData || {},
    deferredLoaderData: init.deferredLoaderData || {},
    actionData: init.actionData,
    catch: init.catch,
    error: init.error,
    catchBoundaryId: init.catchBoundaryId || null,
    errorBoundaryId: init.errorBoundaryId || null,
    matches,
    nextMatches: undefined,
    transition: IDLE_TRANSITION,
    fetchers: new Map(),
  };

  function update(updates: Partial<TransitionManagerState>) {
    if (updates.transition) {
      console.debug(
        `[transition] transition set to ${updates.transition.state}/${updates.transition.type}`
      );
      if (updates.transition === IDLE_TRANSITION) {
        pendingNavigationController = undefined;

        if (!updates.deferredLoaderData) {
          updates.deferredLoaderData = {};
        } else {
          console.log("updates.deferredLoaderData", updates.deferredLoaderData);
        }

        console.log("cancelled", cancelledDeferredRouteIds);
        Object.keys(state.deferredLoaderData)
          .filter((routeId) => !cancelledDeferredRouteIds.has(routeId))
          .forEach((routeId) => {
            console.log("preserving", routeId);
            updates.deferredLoaderData[routeId] =
              state.deferredLoaderData[routeId];
          });

        cancelledDeferredRouteIds.forEach((routeId) => {
          pendingNavigationDeferredControllers.delete(routeId);
        });
      }
    }

    state = Object.assign({}, state, updates);
    init.onChange(state);
  }

  function getState(): TransitionManagerState {
    return state;
  }

  function getFetcher<TData = any>(key: string): Fetcher<TData> {
    return state.fetchers.get(key) || IDLE_FETCHER;
  }

  function setFetcher(key: string, fetcher: Fetcher): void {
    console.debug(
      `[transition] fetcher set to ${fetcher.state}/${fetcher.type} (key: ${key})`
    );
    state.fetchers.set(key, fetcher);
  }

  function deleteFetcher(key: string): void {
    console.debug(`[transition] deleting fetcher (key: ${key})`);
    if (fetchControllers.has(key)) abortFetcher(key);
    fetchReloadIds.delete(key);
    fetchRedirectIds.delete(key);
    state.fetchers.delete(key);
  }

  async function send(event: DataEvent): Promise<void> {
    switch (event.type) {
      case "navigation": {
        let { action, location, submission } = event;

        console.debug(
          `[transition] navigation send() - ${action} ${location.pathname}`
        );
        let matches = matchClientRoutes(routes, location);

        if (!matches) {
          matches = [
            {
              params: {},
              pathname: "",
              route: routes[0],
            },
          ];
          console.debug("[transition]   handling not found navigation");
          await handleNotFoundNavigation(location, matches);
        } else if (!submission && isHashChangeOnly(location)) {
          console.debug("[transition]   handling hash change");
          await handleHashChange(location, matches);
        }
        // back/forward button, treat all as normal navigation
        else if (action === Action.Pop) {
          console.debug(
            "[transition]   handling Action.Pop (back/forward button)"
          );
          await handleLoad(location, matches);
        }
        // <Form method="post | put | delete | patch">
        else if (submission && isActionSubmission(submission)) {
          console.debug("[transition]   handling form action submission");
          await handleActionSubmissionNavigation(location, submission, matches);
        }
        // <Form method="get"/>
        else if (submission && isLoaderSubmission(submission)) {
          console.debug("[transition]   handling form loader submission");
          await handleLoaderSubmissionNavigation(location, submission, matches);
        }
        // action=>redirect
        else if (isActionRedirectLocation(location)) {
          console.debug("[transition]   handling form action redirect");
          await handleActionRedirect(location, matches);
        }
        // <Form method="get"> --> loader=>redirect
        else if (isLoaderSubmissionRedirectLocation(location)) {
          console.debug("[transition]   handling form loader redirect");
          await handleLoaderSubmissionRedirect(location, matches);
        }
        // loader=>redirect
        else if (isLoaderRedirectLocation(location)) {
          console.debug("[transition]   handling loader redirect");
          await handleLoaderRedirect(location, matches);
        }
        // useSubmission()=>redirect
        else if (isFetchActionRedirect(location)) {
          console.debug("[transition]   handling fetcher action redirect");
          await handleFetchActionRedirect(location, matches);
        }
        // <Link>, navigate()
        else {
          console.debug("[transition]   handling link navigation");
          await handleLoad(location, matches);
        }

        navigationLoadId = -1;
        break;
      }

      case "fetcher": {
        let { key, submission, href } = event;
        console.debug(
          `[transition] fetcher send() - ${event.submission?.method} ${href} (key: ${key})`
        );

        let matches = matchClientRoutes(routes, href);
        invariant(matches, "No matches found");
        if (fetchControllers.has(key)) abortFetcher(key);

        let match = getFetcherRequestMatch(
          new URL(href, window.location.href),
          matches
        );

        if (submission && isActionSubmission(submission)) {
          console.debug(
            `[transition]   handling fetcher action submission (key: ${key})`
          );
          await handleActionFetchSubmission(key, submission, match);
        } else if (submission && isLoaderSubmission(submission)) {
          console.debug(
            `[transition]   handling fetcher loader submission (key: ${key})`
          );
          await handleLoaderFetchSubmission(href, key, submission, match);
        } else {
          console.debug(
            `[transition]   handling fetcher loader fetch (key: ${key})`
          );
          await handleLoaderFetch(href, key, match);
        }

        break;
      }

      default: {
        // @ts-ignore
        throw new Error(`Unknown data event type: ${event.type}`);
      }
    }
  }

  function dispose() {
    abortNormalNavigation();
    for (let [, controller] of fetchControllers) {
      controller.abort();
    }
  }

  function isIndexRequestUrl(url: URL) {
    for (let param of url.searchParams.getAll("index")) {
      // only use bare `?index` params without a value
      // ✅ /foo?index
      // ✅ /foo?index&index=123
      // ✅ /foo?index=123&index
      // ❌ /foo?index=123
      if (param === "") {
        return true;
      }
    }

    return false;
  }

  function getFetcherRequestMatch(
    url: URL,
    matches: RouteMatch<ClientRoute>[]
  ) {
    let match = matches.slice(-1)[0];

    if (!isIndexRequestUrl(url) && match.route.index) {
      return matches.slice(-2)[0];
    }

    return match;
  }

  async function handleActionFetchSubmission(
    key: string,
    submission: ActionSubmission,
    match: ClientMatch
  ) {
    let currentFetcher = state.fetchers.get(key);

    let fetcher: FetcherStates["SubmittingAction"] = {
      state: "submitting",
      type: "actionSubmission",
      submission,
      data: currentFetcher?.data || undefined,
    };
    setFetcher(key, fetcher);

    update({ fetchers: new Map(state.fetchers) });

    let controller = new AbortController();
    fetchControllers.set(key, controller);

    console.debug(`[transition] fetcher calling action (key: ${key})`);
    let result = await callAction(submission, match, controller.signal);
    if (controller.signal.aborted) {
      console.debug(`[transition] fetcher action aborted (key: ${key})`);
      return;
    }

    if (isRedirectResult(result)) {
      let locationState: Redirects["FetchAction"] = {
        isRedirect: true,
        type: "fetchAction",
        setCookie: result.value.setCookie,
      };
      fetchRedirectIds.add(key);
      init.onRedirect(result.value.location, locationState);
      let loadingFetcher: FetcherStates["LoadingActionRedirect"] = {
        state: "loading",
        type: "actionRedirect",
        submission,
        data: undefined,
      };
      setFetcher(key, loadingFetcher);
      update({ fetchers: new Map(state.fetchers) });
      return;
    }

    if (maybeBailOnError(match, key, result)) {
      return;
    }

    if (await maybeBailOnCatch(match, key, result)) {
      return;
    }

    let loadFetcher: FetcherStates["ReloadingAction"] = {
      state: "loading",
      type: "actionReload",
      data: result.value,
      submission,
    };
    setFetcher(key, loadFetcher);

    update({ fetchers: new Map(state.fetchers) });

    let maybeActionErrorResult = isErrorResult(result) ? result : undefined;
    let maybeActionCatchResult = isCatchResult(result) ? result : undefined;

    let loadId = ++incrementingLoadId;
    fetchReloadIds.set(key, loadId);

    let matchesToLoad = filterMatchesToLoad(
      state,
      state.transition.location || state.location,
      state.nextMatches || state.matches,
      maybeActionErrorResult,
      maybeActionCatchResult,
      submission,
      match.route.id,
      fetcher
    );

    console.debug(`[transition] fetcher calling loaders (key: ${key})`);
    let results = await callLoaders(
      state,
      state.transition.location || state.location,
      matchesToLoad,
      controller.signal,
      matchesToLoad,
      maybeActionErrorResult,
      maybeActionCatchResult,
      submission,
      match.route.id,
      loadFetcher
    );

    if (controller.signal.aborted) {
      console.debug(`[transition] fetcher loaders aborted (key: ${key})`);
      return;
    }

    fetchReloadIds.delete(key);
    fetchControllers.delete(key);

    let redirect = findRedirect(results);
    if (redirect) {
      let locationState: Redirects["Loader"] = {
        isRedirect: true,
        type: "loader",
        setCookie: redirect.setCookie,
      };
      init.onRedirect(redirect.location, locationState);
      return;
    }

    let [error, errorBoundaryId] = findErrorAndBoundaryId(
      results,
      state.matches,
      maybeActionErrorResult
    );

    let [catchVal, catchBoundaryId] =
      (await findCatchAndBoundaryId(
        results,
        state.matches,
        maybeActionCatchResult
      )) || [];

    let doneFetcher: FetcherStates["Done"] = {
      state: "idle",
      type: "done",
      data: result.value,
      submission: undefined,
    };
    setFetcher(key, doneFetcher);

    let abortedKeys = abortStaleFetchLoads(loadId);
    if (abortedKeys) {
      console.debug(
        `[transition] marking aborted fetchers as done (keys: ${abortedKeys})`
      );
      markFetchersDone(abortedKeys);
    }

    let yeetedNavigation = yeetStaleNavigationLoad(loadId);

    // need to do what we would have done when the navigation load completed
    if (yeetedNavigation) {
      let { transition } = state;
      invariant(transition.state === "loading", "Expected loading transition");

      console.debug(
        `[transition] setting transition back to idle due to aborted navigation (key: ${key})`
      );
      update({
        location: transition.location,
        matches: state.nextMatches,
        error,
        errorBoundaryId,
        catch: catchVal,
        catchBoundaryId,
        loaderData: makeLoaderData(state, results, matchesToLoad),
        actionData:
          transition.type === "actionReload" ? state.actionData : undefined,
        transition: IDLE_TRANSITION,
        fetchers: new Map(state.fetchers),
      });
    }

    // otherwise just update the info for the data
    else {
      update({
        fetchers: new Map(state.fetchers),
        error,
        errorBoundaryId,
        loaderData: makeLoaderData(state, results, matchesToLoad),
      });
    }
  }

  function yeetStaleNavigationLoad(landedId: number): boolean {
    let isLoadingNavigation = state.transition.state === "loading";
    if (isLoadingNavigation && navigationLoadId < landedId) {
      abortNormalNavigation();
      return true;
    }
    return false;
  }

  function markFetchersDone(keys: string[]) {
    for (let key of keys) {
      let fetcher = getFetcher(key);
      let doneFetcher: FetcherStates["Done"] = {
        state: "idle",
        type: "done",
        data: fetcher.data,
        submission: undefined,
      };
      setFetcher(key, doneFetcher);
    }
  }

  function abortStaleFetchLoads(landedId: number): false | string[] {
    let yeetedKeys = [];
    for (let [key, id] of fetchReloadIds) {
      if (id < landedId) {
        let fetcher = state.fetchers.get(key);
        invariant(fetcher, `Expected fetcher: ${key}`);
        if (fetcher.state === "loading") {
          abortFetcher(key);
          fetchReloadIds.delete(key);
          yeetedKeys.push(key);
        }
      }
    }
    return yeetedKeys.length ? yeetedKeys : false;
  }

  async function handleLoaderFetchSubmission(
    href: string,
    key: string,
    submission: LoaderSubmission,
    match: ClientMatch
  ) {
    let currentFetcher = state.fetchers.get(key);
    let fetcher: FetcherStates["SubmittingLoader"] = {
      state: "submitting",
      type: "loaderSubmission",
      submission,
      data: currentFetcher?.data || undefined,
    };

    setFetcher(key, fetcher);
    update({ fetchers: new Map(state.fetchers) });

    let controller = new AbortController();
    fetchControllers.set(key, controller);
    let result = await callLoader(match, createUrl(href), controller.signal);
    fetchControllers.delete(key);

    if (controller.signal.aborted) {
      console.debug(`[transition] fetcher loader aborted (key: ${key})`);
      return;
    }

    if (isRedirectResult(result)) {
      let locationState: Redirects["Loader"] = {
        isRedirect: true,
        type: "loader",
        setCookie: result.value.setCookie,
      };
      init.onRedirect(result.value.location, locationState);
      return;
    }

    if (maybeBailOnError(match, key, result)) {
      return;
    }

    if (await maybeBailOnCatch(match, key, result)) {
      return;
    }

    let doneFetcher: FetcherStates["Done"] = {
      state: "idle",
      type: "done",
      data: result.value,
      submission: undefined,
    };
    setFetcher(key, doneFetcher);

    update({ fetchers: new Map(state.fetchers) });
  }

  async function handleLoaderFetch(
    href: string,
    key: string,
    match: ClientMatch
  ) {
    if (typeof AbortController === "undefined") {
      throw new Error(
        "handleLoaderFetch was called during the server render, but it shouldn't be. " +
          "You are likely calling useFetcher.load() in the body of your component. " +
          "Try moving it to a useEffect or a callback."
      );
    }
    let currentFetcher = state.fetchers.get(key);

    let fetcher: FetcherStates["Loading"] = {
      state: "loading",
      type: "normalLoad",
      submission: undefined,
      data: currentFetcher?.data || undefined,
    };

    setFetcher(key, fetcher);
    update({ fetchers: new Map(state.fetchers) });

    let controller = new AbortController();
    fetchControllers.set(key, controller);
    let result = await callLoader(match, createUrl(href), controller.signal);

    if (controller.signal.aborted) return;
    fetchControllers.delete(key);

    if (isRedirectResult(result)) {
      let locationState: Redirects["Loader"] = {
        isRedirect: true,
        type: "loader",
        setCookie: result.value.setCookie,
      };
      init.onRedirect(result.value.location, locationState);
      return;
    }

    if (maybeBailOnError(match, key, result)) {
      return;
    }

    if (await maybeBailOnCatch(match, key, result)) {
      return;
    }

    let doneFetcher: FetcherStates["Done"] = {
      state: "idle",
      type: "done",
      data: result.value,
      submission: undefined,
    };
    setFetcher(key, doneFetcher);

    update({ fetchers: new Map(state.fetchers) });
  }

  async function maybeBailOnCatch(
    match: ClientMatch,
    key: string,
    result: DataResult
  ) {
    // TODO: revisit this if submission is correct after review
    if (isCatchResult(result)) {
      let catchBoundaryId = findNearestCatchBoundary(match, state.matches);
      state.fetchers.delete(key);
      update({
        transition: IDLE_TRANSITION,
        fetchers: new Map(state.fetchers),
        catch: {
          data: result.value.data,
          status: result.value.status,
          statusText: result.value.statusText,
        },
        catchBoundaryId,
      });
      return true;
    }
    return false;
  }

  function maybeBailOnError(
    match: ClientMatch,
    key: string,
    result: DataResult
  ) {
    if (isErrorResult(result)) {
      let errorBoundaryId = findNearestBoundary(match, state.matches);
      state.fetchers.delete(key);
      update({
        fetchers: new Map(state.fetchers),
        error: result.value,
        errorBoundaryId,
      });
      return true;
    }
    return false;
  }

  async function handleNotFoundNavigation(
    location: Location,
    matches: RouteMatch<ClientRoute>[]
  ) {
    abortNormalNavigation();
    let transition: TransitionStates["Loading"] = {
      state: "loading",
      type: "normalLoad",
      submission: undefined,
      location,
    };
    update({ transition, nextMatches: matches });

    // Force async so UI code doesn't have to special not found route changes not
    // skipping the pending state (like scroll restoration gets really
    // complicated without the pending state, maybe we can figure something else
    // out later, but this works great.)
    await Promise.resolve();

    let catchBoundaryId = findNearestCatchBoundary(matches[0], matches);
    update({
      location,
      matches,
      catch: {
        data: null,
        status: 404,
        statusText: "Not Found",
      },
      catchBoundaryId,
      transition: IDLE_TRANSITION,
    });
  }

  async function handleActionSubmissionNavigation(
    location: Location,
    submission: ActionSubmission,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();

    let transition: TransitionStates["SubmittingAction"] = {
      state: "submitting",
      type: "actionSubmission",
      submission,
      location,
    };

    update({ transition, nextMatches: matches });

    let controller = new AbortController();
    pendingNavigationController = controller;

    // Create a local copy we can mutate for proper determination of the acton
    // to run on layout/index routes.  We do not want to mutate the eventual
    // matches used for revalidation
    let actionMatches = matches;
    if (
      !isIndexRequestUrl(createUrl(submission.action)) &&
      actionMatches[matches.length - 1].route.index
    ) {
      actionMatches = actionMatches.slice(0, -1);
    }

    let leafMatch = actionMatches.slice(-1)[0];
    let result = await callAction(submission, leafMatch, controller.signal);

    if (controller.signal.aborted) {
      return;
    }

    if (isRedirectResult(result)) {
      let locationState: Redirects["Action"] = {
        isRedirect: true,
        type: "action",
        setCookie: result.value.setCookie,
      };
      init.onRedirect(result.value.location, locationState);
      return;
    }

    let catchVal, catchBoundaryId;
    if (isCatchResult(result)) {
      [catchVal, catchBoundaryId] =
        (await findCatchAndBoundaryId([result], actionMatches, result)) || [];
    }

    let loadTransition: TransitionStates["LoadingAction"] = {
      state: "loading",
      type: "actionReload",
      submission,
      location,
    };

    update({
      transition: loadTransition,
      actionData: { [leafMatch.route.id]: result.value },
    });

    await loadPageData(
      location,
      matches,
      submission,
      leafMatch.route.id,
      result,
      catchVal,
      catchBoundaryId
    );
  }

  async function handleLoaderSubmissionNavigation(
    location: Location,
    submission: LoaderSubmission,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();
    let transition: TransitionStates["SubmittingLoader"] = {
      state: "submitting",
      type: "loaderSubmission",
      submission,
      location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches, submission);
  }

  async function handleHashChange(location: Location, matches: ClientMatch[]) {
    abortNormalNavigation();
    let transition: TransitionStates["Loading"] = {
      state: "loading",
      type: "normalLoad",
      submission: undefined,
      location,
    };
    update({ transition, nextMatches: matches });
    // Force async so UI code doesn't have to special case hash changes not
    // skipping the pending state (like scroll restoration gets really
    // complicated without the pending state, maybe we can figure something else
    // out later, but this works great.)
    await Promise.resolve();
    update({
      location,
      matches,
      transition: IDLE_TRANSITION,
    });
  }

  async function handleLoad(location: Location, matches: ClientMatch[]) {
    abortNormalNavigation();
    let transition: TransitionStates["Loading"] = {
      state: "loading",
      type: "normalLoad",
      submission: undefined,
      location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches);
  }

  async function handleLoaderRedirect(
    location: Location,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();
    let transition: TransitionStates["LoadingRedirect"] = {
      state: "loading",
      type: "normalRedirect",
      submission: undefined,
      location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches);
  }

  async function handleLoaderSubmissionRedirect(
    location: Location,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();
    invariant(
      state.transition.type === "loaderSubmission",
      `Unexpected transition: ${JSON.stringify(state.transition)}`
    );
    let { submission } = state.transition;
    let transition: TransitionStates["LoadingLoaderSubmissionRedirect"] = {
      state: "loading",
      type: "loaderSubmissionRedirect",
      submission,
      location: location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches, submission);
  }

  async function handleFetchActionRedirect(
    location: Location,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();
    let transition: TransitionStates["LoadingFetchActionRedirect"] = {
      state: "loading",
      type: "fetchActionRedirect",
      submission: undefined,
      location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches);
  }

  async function handleActionRedirect(
    location: Location,
    matches: ClientMatch[]
  ) {
    abortNormalNavigation();
    invariant(
      state.transition.type === "actionSubmission" ||
        // loader redirected during action reload
        state.transition.type === "actionReload",
      `Unexpected transition: ${JSON.stringify(state.transition)}`
    );
    let { submission } = state.transition;
    let transition: TransitionStates["LoadingActionRedirect"] = {
      state: "loading",
      type: "actionRedirect",
      submission,
      location,
    };
    update({ transition, nextMatches: matches });
    await loadPageData(location, matches, submission);
  }

  function isHashChangeOnly(location: Location) {
    return (
      createHref(state.location) === createHref(location) &&
      state.location.hash !== location.hash
    );
  }

  async function loadPageData(
    location: Location,
    matches: ClientMatch[],
    submission?: Submission,
    submissionRouteId?: string,
    actionResult?: DataResult,
    catchVal?: CatchData<any>,
    catchBoundaryId?: string | null
  ) {
    let maybeActionErrorResult =
      actionResult && isErrorResult(actionResult) ? actionResult : undefined;

    let maybeActionCatchResult =
      actionResult && isCatchResult(actionResult) ? actionResult : undefined;

    let controller = new AbortController();
    pendingNavigationController = controller;
    navigationLoadId = ++incrementingLoadId;

    console.debug("[transition] calling loaders for loadPageData");

    let matchesToLoad = filterMatchesToLoad(
      state,
      location,
      matches,
      maybeActionErrorResult,
      maybeActionCatchResult,
      submission,
      submissionRouteId,
      undefined,
      catchBoundaryId
    );

    console.log(
      "matches",
      matches.map((m) => m.route.id)
    );
    console.log(
      "matchesToLoad",
      matchesToLoad.map((m) => m.route.id)
    );
    abortPendingDeferredControllers(matches, matchesToLoad);

    let results = await callLoaders(
      state,
      location,
      matches,
      controller.signal,
      matchesToLoad,
      maybeActionErrorResult,
      maybeActionCatchResult,
      submission,
      submissionRouteId,
      undefined,
      catchBoundaryId
    );

    if (controller.signal.aborted) {
      console.debug("[transition] transition loaders aborted");
      return;
    }

    let redirect = findRedirect(results);
    if (redirect) {
      console.debug(
        `[transition] transition loaders redirected to ${redirect.location}`
      );
      // loader redirected during an action reload, treat it like an
      // actionRedirect instead so that all the loaders get called again and the
      // submission sticks around for optimistic/pending UI.
      if (state.transition.type === "actionReload") {
        let locationState: Redirects["Action"] = {
          isRedirect: true,
          type: "action",
          setCookie: redirect.setCookie,
        };
        init.onRedirect(redirect.location, locationState);
      } else if (state.transition.type === "loaderSubmission") {
        let locationState: Redirects["LoaderSubmission"] = {
          isRedirect: true,
          type: "loaderSubmission",
          setCookie: redirect.setCookie,
        };
        init.onRedirect(redirect.location, locationState);
      } else {
        let locationState: Redirects["Loader"] = {
          isRedirect: true,
          type: "loader",
          setCookie: redirect.setCookie,
        };
        init.onRedirect(redirect.location, locationState);
      }
      return;
    }

    let [error, errorBoundaryId] = findErrorAndBoundaryId(
      results,
      matches,
      maybeActionErrorResult
    );

    [catchVal, catchBoundaryId] = (await findCatchAndBoundaryId(
      results,
      matches,
      maybeActionErrorResult
    )) || [catchVal, catchBoundaryId];

    markFetchRedirectsDone();

    let abortedIds = abortStaleFetchLoads(navigationLoadId);
    if (abortedIds) {
      console.debug(
        `[transition] marking aborted fetchers as done (keys: ${abortedIds})`
      );
      markFetchersDone(abortedIds);
    }

    let [deferredLoaderData, monitorDeferred] = makeDeferredLoaderData(
      getState,
      update,
      results,
      pendingNavigationDeferredControllers
    );
    console.log("deferredLoaderData", deferredLoaderData);
    update({
      location,
      matches,
      error,
      errorBoundaryId,
      catch: catchVal,
      catchBoundaryId,
      loaderData: makeLoaderData(state, results, matches),
      deferredLoaderData,
      actionData:
        state.transition.type === "actionReload" ? state.actionData : undefined,
      transition: IDLE_TRANSITION,
      fetchers: abortedIds ? new Map(state.fetchers) : state.fetchers,
    });

    monitorDeferred();
  }

  function abortNormalNavigation() {
    if (pendingNavigationController) {
      console.debug(`[transition] aborting pending navigation`);
      pendingNavigationController.abort();
    }
  }

  function abortPendingDeferredControllers(matches, matchesToLoad) {
    // TODO: On normal new GET navigations, we only want to cancel deferred
    //       below the reused routes
    // TODO: If we cancel a pending deferred at the start of an action, we have
    //       to ignore unstable_shouldReload and force a reload on the next
    //       subsequent loader call
    for (let [routeId, controller] of pendingNavigationDeferredControllers) {
      // TODO: what about boundaries?
      // Can cancel if this route is no longer matched
      let isRouteMatched = matches?.some((m) => m.route.id === routeId);
      // Or if this route is about to be reloaded
      let isRouteLoading = matchesToLoad?.some((m) => m.route.id === routeId);
      console.log("checking", { routeId, isRouteMatched, isRouteLoading });
      if (!isRouteMatched || isRouteLoading) {
        console.log("Cancelling");
        controller.abort();
        cancelledDeferredRouteIds.add(routeId);
      }
    }
  }

  function abortFetcher(key: string) {
    console.debug(`[transition] aborting fetcher (key: ${key})`);
    let controller = fetchControllers.get(key);
    invariant(controller, `Expected fetch controller: ${key}`);
    controller.abort();
    fetchControllers.delete(key);
  }

  function markFetchRedirectsDone(): void {
    let doneKeys = [];
    for (let key of fetchRedirectIds) {
      let fetcher = state.fetchers.get(key);
      invariant(fetcher, `Expected fetcher: ${key}`);
      if (fetcher.type === "actionRedirect") {
        fetchRedirectIds.delete(key);
        doneKeys.push(key);
      }
    }
    markFetchersDone(doneKeys);
  }

  return {
    send,
    getState,
    getFetcher,
    deleteFetcher,
    dispose,
    get _internalFetchControllers() {
      return fetchControllers;
    },
  };
}
//#endregion

////////////////////////////////////////////////////////////////////////////////
//#region createTransitionManager sub-functions
////////////////////////////////////////////////////////////////////////////////
async function callLoaders(
  state: TransitionManagerState,
  location: Location,
  matches: ClientMatch[],
  signal: AbortSignal,
  matchesToLoad: ClientMatch[],
  actionErrorResult?: DataErrorResult,
  actionCatchResult?: DataCatchResult,
  submission?: Submission,
  submissionRouteId?: string,
  fetcher?: Fetcher,
  catchBoundaryId?: string | null
): Promise<DataResult[]> {
  let url = createUrl(createHref(location));
  // let matchesToLoad = filterMatchesToLoad(
  //   state,
  //   location,
  //   matches,
  //   actionErrorResult,
  //   actionCatchResult,
  //   submission,
  //   submissionRouteId,
  //   fetcher,
  //   catchBoundaryId
  // );

  return Promise.all(
    matchesToLoad.map((match) => callLoader(match, url, signal))
  );
}

async function callLoader(match: ClientMatch, url: URL, signal: AbortSignal) {
  invariant(match.route.loader, `Expected loader for ${match.route.id}`);
  try {
    let { params } = match;
    let response = await match.route.loader({ params, url, signal });

    let value = response;
    let deferred: Record<string, Promise<unknown>> | undefined;
    if (response instanceof DeferredResponse) {
      let parsed = await parseDataFromDeferredReadableStream(
        response.response.body
      );
      value = parsed.initialData;
      deferred = parsed.deferred;
    }

    return { match, value, deferred };
  } catch (error) {
    return { match, value: error };
  }
}

async function callAction(
  submission: ActionSubmission,
  match: ClientMatch,
  signal: AbortSignal
): Promise<DataResult> {
  try {
    let value = await match.route.action({
      url: createUrl(submission.action),
      params: match.params,
      submission,
      signal,
    });
    return { match, value };
  } catch (error) {
    return { match, value: error };
  }
}

function filterMatchesToLoad(
  state: TransitionManagerState,
  location: Location,
  matches: ClientMatch[],
  actionErrorResult?: DataErrorResult,
  actionCatchResult?: DataCatchResult,
  submission?: Submission,
  submissionRouteId?: string,
  fetcher?: Fetcher,
  catchBoundaryId?: string | null
): ClientMatch[] {
  // Filter out all routes below the problematic route as they aren't going
  // to render so we don't need to load them.
  if (
    catchBoundaryId ||
    (submissionRouteId && (actionCatchResult || actionErrorResult))
  ) {
    let foundProblematicRoute = false;
    matches = matches.filter((match) => {
      if (foundProblematicRoute) {
        return false;
      }
      if (
        match.route.id === submissionRouteId ||
        match.route.id === catchBoundaryId
      ) {
        foundProblematicRoute = true;
        return false;
      }
      return true;
    });
  }

  let isNew = (match: ClientMatch, index: number) => {
    // [a] -> [a, b]
    if (!state.matches[index]) return true;

    // [a, b] -> [a, c]
    return match.route.id !== state.matches[index].route.id;
  };

  let matchPathChanged = (match: ClientMatch, index: number) => {
    return (
      // param change, /users/123 -> /users/456
      state.matches[index].pathname !== match.pathname ||
      // splat param changed, which is not present in match.path
      // e.g. /files/images/avatar.jpg -> files/finances.xls
      (state.matches[index].route.path?.endsWith("*") &&
        state.matches[index].params["*"] !== match.params["*"])
    );
  };

  let url = createUrl(createHref(location));

  let filterByRouteProps = (match: ClientMatch, index: number) => {
    if (!match.route.loader) {
      return false;
    }

    if (isNew(match, index) || matchPathChanged(match, index)) {
      return true;
    }

    if (match.route.shouldReload) {
      let prevUrl = createUrl(createHref(state.location));
      return match.route.shouldReload({
        prevUrl,
        url,
        submission,
        params: match.params,
      });
    }

    return true;
  };

  let isInRootCatchBoundary = state.matches.length === 1;
  if (isInRootCatchBoundary) {
    return matches.filter((match) => !!match.route.loader);
  }

  if (fetcher?.type === "actionReload") {
    return matches.filter(filterByRouteProps);
  } else if (
    // mutation, reload for fresh data
    state.transition.type === "actionReload" ||
    state.transition.type === "actionRedirect" ||
    state.transition.type === "fetchActionRedirect" ||
    // clicked the same link, resubmitted a GET form
    createHref(url) === createHref(state.location) ||
    // search affects all loaders
    url.searchParams.toString() !== state.location.search.substring(1) ||
    // a cookie was set
    (location.state as any)?.setCookie
  ) {
    console.log(1);
    return matches.filter(filterByRouteProps);
  }

  console.log(2);
  return matches.filter((match, index, arr) => {
    // don't load errored action route
    if ((actionErrorResult || actionCatchResult) && arr.length - 1 === index) {
      return false;
    }

    return (
      match.route.loader &&
      (isNew(match, index) ||
        matchPathChanged(match, index) ||
        (location.state as any)?.setCookie)
    );
  });
}

function isRedirectResult(result: DataResult): result is DataRedirectResult {
  return result.value instanceof TransitionRedirect;
}

function createHref(location: Location | URL) {
  return location.pathname + location.search;
}

function findRedirect(results: DataResult[]): TransitionRedirect | null {
  for (let result of results) {
    if (isRedirectResult(result)) {
      return result.value;
    }
  }
  return null;
}

async function findCatchAndBoundaryId(
  results: DataResult[],
  matches: ClientMatch[],
  actionCatchResult?: DataCatchResult
): Promise<[CatchData, string | null] | null> {
  let loaderCatchResult: DataCatchResult | undefined;

  for (let result of results) {
    if (isCatchResult(result)) {
      loaderCatchResult = result;
      break;
    }
  }

  let extractCatchData = async (res: CatchValue) => ({
    status: res.status,
    statusText: res.statusText,
    data: res.data,
  });

  // Weird case where action threw, and then a parent loader ALSO threw, we
  // use the action catch but the loader's nearest boundary (cause we can't
  // render down to the boundary the action would prefer)
  if (actionCatchResult && loaderCatchResult) {
    let boundaryId = findNearestCatchBoundary(loaderCatchResult.match, matches);
    return [await extractCatchData(actionCatchResult.value), boundaryId];
  }

  if (loaderCatchResult) {
    let boundaryId = findNearestCatchBoundary(loaderCatchResult.match, matches);
    return [await extractCatchData(loaderCatchResult.value), boundaryId];
  }

  return null;
}

function findErrorAndBoundaryId(
  results: DataResult[],
  matches: ClientMatch[],
  actionErrorResult?: DataErrorResult
): [Error, string | null] | [undefined, undefined] {
  let loaderErrorResult;

  for (let result of results) {
    if (isErrorResult(result)) {
      loaderErrorResult = result;
      break;
    }
  }

  // Weird case where action errored, and then a parent loader ALSO errored, we
  // use the action error but the loader's nearest boundary (cause we can't
  // render down to the boundary the action would prefer)
  if (actionErrorResult && loaderErrorResult) {
    let boundaryId = findNearestBoundary(loaderErrorResult.match, matches);
    return [actionErrorResult.value, boundaryId];
  }

  if (actionErrorResult) {
    let boundaryId = findNearestBoundary(actionErrorResult.match, matches);
    return [actionErrorResult.value, boundaryId];
  }

  if (loaderErrorResult) {
    let boundaryId = findNearestBoundary(loaderErrorResult.match, matches);
    return [loaderErrorResult.value, boundaryId];
  }

  return [undefined, undefined];
}

function findNearestCatchBoundary(
  matchWithError: ClientMatch,
  matches: ClientMatch[]
): string | null {
  let nearestBoundaryId: null | string = null;
  for (let match of matches) {
    if (match.route.CatchBoundary) {
      nearestBoundaryId = match.route.id;
    }

    // only search parents (stop at throwing match)
    if (match === matchWithError) {
      break;
    }
  }

  return nearestBoundaryId;
}

function findNearestBoundary(
  matchWithError: ClientMatch,
  matches: ClientMatch[]
): string | null {
  let nearestBoundaryId: null | string = null;
  for (let match of matches) {
    if (match.route.ErrorBoundary) {
      nearestBoundaryId = match.route.id;
    }

    // only search parents (stop at throwing match)
    if (match === matchWithError) {
      break;
    }
  }

  return nearestBoundaryId;
}

function makeLoaderData(
  state: TransitionManagerState,
  results: DataResult[],
  matches: ClientMatch[]
) {
  let newData: RouteData = {};
  for (let { match, value } of results) {
    newData[match.route.id] = value;
  }

  let loaderData: RouteData = {};
  for (let { route } of matches) {
    let value =
      newData[route.id] !== undefined
        ? newData[route.id]
        : state.loaderData[route.id];
    if (value !== undefined) {
      loaderData[route.id] = value;
    }
  }

  return loaderData;
}

function makeDeferredLoaderData(
  getState: () => TransitionManagerState,
  update: (updates: Partial<TransitionManagerState>) => void,
  results: DataResult[],
  pendingNavigationDeferredControllers: Map<string, AbortController>
): [DeferredRouteData, () => void] {
  let state = getState();
  // TODO: This may need to be cancel-aware
  let deferredLoaderData = { ...state.deferredLoaderData };
  for (let { match, deferred } of results) {
    if (!deferred) continue;
    deferredLoaderData[match.route.id] = Object.assign(
      {},
      deferredLoaderData[match.route.id],
      deferred
    );
    let deferredController = new AbortController();
    pendingNavigationDeferredControllers.set(
      match.route.id,
      deferredController
    );
  }

  return [
    deferredLoaderData,
    () => {
      for (let { match, deferred } of results) {
        if (!deferred) continue;
        for (let [key, promise] of Object.entries(deferred)) {
          let signal = pendingNavigationDeferredControllers.get(
            match.route.id
          )?.signal;
          if (!signal || signal.aborted) continue;
          deferredLoaderData[match.route.id][key] = promise;
          promise.then((value) => {
            if (signal!.aborted) return;

            let state = { ...getState() };
            let {
              [match.route.id]: { [key]: _, ...routeDeferredLoaderData } = {},
              ...deferredLoaderData
            } = state.deferredLoaderData;

            let newDeferredLoaderData = {
              ...deferredLoaderData,
              [match.route.id]: routeDeferredLoaderData,
            };

            let { [match.route.id]: routeLoaderData, ...loaderData } =
              state.loaderData;

            let newLoaderData = {
              ...loaderData,
              [match.route.id]: {
                ...routeLoaderData,
                [key]: value,
              },
            };

            if (signal!.aborted) return;
            update({
              deferredLoaderData: newDeferredLoaderData,
              loaderData: newLoaderData,
            });
          });
        }
      }
    },
  ];
}

function isCatchResult(result: DataResult): result is DataCatchResult {
  return result.value instanceof CatchValue;
}

function isErrorResult(result: DataResult) {
  return result.value instanceof Error;
}

function createUrl(href: string) {
  return new URL(href, window.location.origin);
}
//#endregion
