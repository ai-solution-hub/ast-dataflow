// Hand-written miniature of the generated supabase/types/database.types.ts —
// the exact nesting the ad-hoc schema parse walks: Database → public →
// Tables → <table> → Row. Decoys the parser must skip: the `api` schema
// (real generated file has one), Insert/Update/Relationships members, and
// Views/Functions/Enums containers.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  api: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      bid_projects: {
        Row: {
          api_only_decoy: string | null;
        };
      };
    };
  };
  public: {
    Tables: {
      bid_projects: {
        Row: {
          budget_gbp: number | null;
          id: string;
          owner_id: string;
          title: string;
        };
        Insert: {
          budget_gbp?: number | null;
          id?: string;
          insert_only_decoy?: string;
          owner_id: string;
          title: string;
        };
        Update: {
          budget_gbp?: number | null;
          id?: string;
          owner_id?: string;
          title?: string;
        };
        Relationships: [];
      };
      feed_articles: {
        Row: {
          extraction_method: string;
          headline: string;
          id: string;
          retention_class: string;
        };
        Insert: {
          extraction_method?: string;
          headline: string;
          id?: string;
          retention_class?: string;
        };
        Relationships: [];
      };
      signup_policy: {
        Row: {
          allowed_domain: string;
          enforced: boolean;
          id: string;
          updated_at: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      hook_restrict_signup: {
        Args: { p_domain: string };
        Returns: boolean;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
