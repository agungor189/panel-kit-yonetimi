export type AuthenticatedUser = {
  id: string;
  username: string;
  role: string;
  permissions: Record<string, unknown>;
  must_change_password: boolean;
  session_epoch: number;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      panelApiKey?: {
        id: string;
        name: string;
        permissions: string[];
      };
      servicePrincipal?: {
        id: string;
        name: string;
        scopes: string[];
      };
    }
  }
}
