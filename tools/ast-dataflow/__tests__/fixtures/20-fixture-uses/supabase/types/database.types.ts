// Hand-written miniature of the generated supabase/types/database.types.ts:
// PropertySignature names are 'key' rows; string-literal union members
// (enum-ish values) are 'value' rows (D3).
export type Database = {
  public: {
    Tables: {
      bid_questions: {
        Row: {
          id: string;
          project_id: string;
          status: 'draft' | 'submitted';
        };
        Insert: {
          id?: string;
          project_id: string;
          status?: 'draft' | 'submitted';
        };
      };
    };
  };
};

export type WorkflowColumn = 'project_id' | 'created_at';
