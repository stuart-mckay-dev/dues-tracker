import { useEffect, useState } from "preact/hooks";

/**
 * Hash routing — no dependency, and it works identically whether the SPA is
 * served by Vite in dev or by Workers static assets in production.
 */

export type Route =
  | { name: "dashboard" }
  | { name: "roster" }
  | { name: "member"; id: string }
  | { name: "ledger" }
  | { name: "report" }
  | { name: "settings" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  const [head, tail] = path.split("/");

  switch (head) {
    case "roster":
      return { name: "roster" };
    case "member":
      return tail ? { name: "member", id: tail } : { name: "roster" };
    case "ledger":
      return { name: "ledger" };
    case "report":
      return { name: "report" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "dashboard" };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

export function navigate(to: string): void {
  location.hash = to;
}
