const supabase = require("../supabase/client");

const TABLE = "fb_posts";

const FbPost = {
    /**
     * Upsert a post (insert or update on conflict by id).
     * @param {{
     *   id: string,
     *   caption?: string,
     *   postDate?: string | Date,
     *   barangay?: string
     * }} data
     */
    async upsert(data) {
        const row = {
            id: data.id,
            caption: data.caption || "",
            post_date: data.postDate || data.post_date,
            barangay: data.barangay || "Unknown"
        };

        const { data: upserted, error } = await supabase
            .from(TABLE)
            .upsert(row, { onConflict: "id" })
            .select()
            .single();

        if (error) throw new Error(`Supabase post upsert error: ${error.message}`);
        return upserted;
    },

    /**
     * Fetch recent posts.
     * @param {number} limit
     */
    async findRecent(limit = 100) {
        const { data, error } = await supabase
            .from(TABLE)
            .select("*")
            .order("post_date", { ascending: false })
            .limit(limit);

        if (error) throw new Error(`Supabase post fetch error: ${error.message}`);
        return data || [];
    }
};

module.exports = FbPost;
