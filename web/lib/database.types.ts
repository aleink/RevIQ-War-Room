// Auto-generated database types for Supabase client
// Mirrors the schema in supabase/migration.sql

export interface Database {
  public: {
    Tables: {
      tasks: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          assigned_to: string;
          status: 'open' | 'in_progress' | 'done';
          priority: 'low' | 'normal' | 'high';
          created_by: string;
          source_message_id: number | null;
          due_date: string | null;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          assigned_to: string;
          status?: 'open' | 'in_progress' | 'done';
          priority?: 'low' | 'normal' | 'high';
          created_by: string;
          source_message_id?: number | null;
          due_date?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
          assigned_to?: string;
          status?: 'open' | 'in_progress' | 'done';
          priority?: 'low' | 'normal' | 'high';
          created_by?: string;
          source_message_id?: number | null;
          due_date?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
      };
      decisions: {
        Row: {
          id: string;
          decision: string;
          context: string | null;
          decided_by: string;
          source_message_id: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          decision: string;
          context?: string | null;
          decided_by: string;
          source_message_id?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          decision?: string;
          context?: string | null;
          decided_by?: string;
          source_message_id?: number | null;
          created_at?: string;
        };
      };
      messages: {
        Row: {
          id: string;
          telegram_message_id: number;
          sender_name: string;
          sender_telegram_id: number;
          text: string | null;
          file_type: string | null;
          file_id: string | null;
          reply_to_message_id: number | null;
          tags: string[] | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          telegram_message_id: number;
          sender_name: string;
          sender_telegram_id: number;
          text?: string | null;
          file_type?: string | null;
          file_id?: string | null;
          reply_to_message_id?: number | null;
          tags?: string[] | null;
          created_at?: string;
        };
        Update: {
          tags?: string[] | null;
          text?: string | null;
        };
      };
      team_members: {
        Row: {
          id: string;
          name: string;
          telegram_username: string;
          telegram_id: number;
          role: string;
        };
        Insert: {
          id?: string;
          name: string;
          telegram_username: string;
          telegram_id: number;
          role: string;
        };
        Update: {
          name?: string;
          telegram_username?: string;
          telegram_id?: number;
          role?: string;
        };
      };
      interventions: {
        Row: {
          id: string;
          trigger_reason: string;
          message_text: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          trigger_reason: string;
          message_text: string;
          created_at?: string;
        };
        Update: {
          trigger_reason?: string;
          message_text?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
