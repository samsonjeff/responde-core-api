const supabase = require("../supabase/client");

const TABLE = "fb_comments";

const FbComment = {
    /**
     * Upsert a comment (insert or update on conflict by id).
     * @param {{
     *   id: string,
     *   postId: string,
     *   userName?: string,
     *   commentText?: string,
     *   commentDate?: string,
     *   commentTime?: string,
     *   barangay?: string,
     *   incidentType?: string
     * }} data
     */
    async upsert(data) {
        const row = {
            id: data.id,
            post_id: data.postId || data.post_id,
            user_name: data.userName || data.user_name || "Unknown",
            comment_text: data.commentText || data.comment_text || "",
            comment_date: data.commentDate || data.comment_date,
            comment_time: data.commentTime || data.comment_time,
            barangay: data.barangay || "Unknown",
            incident_type: data.incidentType !== undefined ? data.incidentType : data.incident_type
        };

        const { data: upserted, error } = await supabase
            .from(TABLE)
            .upsert(row, { onConflict: "id" })
            .select()
            .single();

        if (error) throw new Error(`Supabase comment upsert error: ${error.message}`);
        return upserted;
    },

    /**
     * Fetch recent comments.
     * @param {number} limit
     */
    async findRecent(limit = 100) {
        const { data, error } = await supabase
            .from(TABLE)
            .select("*")
            .order("comment_date", { ascending: false })
            .limit(limit);

        if (error) throw new Error(`Supabase comment fetch error: ${error.message}`);
        return data || [];
    },

    /**
     * Return all comment IDs stored in the DB for a given post.
     * Used by the scraper reconciliation step to detect deleted comments.
     * @param {string} postId
     * @returns {Promise<string[]>}
     */
    async findIdsByPostId(postId) {
        const { data, error } = await supabase
            .from(TABLE)
            .select("id")
            .eq("post_id", postId);

        if (error) throw new Error(`Supabase comment ID fetch error: ${error.message}`);
        return (data || []).map(row => row.id);
    },

    /**
     * Hard-delete a batch of comments by their IDs.
     * Called when reconciliation detects IDs that no longer exist on Facebook.
     * @param {string[]} ids
     * @returns {Promise<number>} number of rows deleted
     */
    async deleteByIds(ids) {
        if (!ids || ids.length === 0) return 0;

        const { data, error } = await supabase
            .from(TABLE)
            .delete()
            .in("id", ids)
            .select();

        if (error) throw new Error(`Supabase comment delete error: ${error.message}`);
        return (data || []).length;
    }
};

module.exports = FbComment;
