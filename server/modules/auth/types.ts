export type AuthenticatedUser = {
  id: string;
  username: string;
  role: string;
  permissions: Record<string, unknown>;
  must_change_password: boolean;
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
    }
  }
}

