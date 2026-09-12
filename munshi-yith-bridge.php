<?php
/**
 * Munshi <-> YITH WooCommerce Affiliates bridge
 *
 * WHAT THIS DOES: adds one small, secured REST endpoint
 * (/wp-json/munshi/v1/affiliates) that reads YITH WooCommerce Affiliates'
 * own database tables and returns a plain summary per affiliate — name,
 * commission rate, pending commission, paid commission, and an
 * approximate sales figure. Munshi's backend calls this endpoint when you
 * press "Sync WooCommerce" or "Sync Affiliates".
 *
 * HOW TO INSTALL (no theme editing, no FTP needed):
 * 1. In WordPress Admin, install and activate the free "Code Snippets" plugin
 *    (Plugins → Add New → search "Code Snippets").
 * 2. Code Snippets → Add New. Paste this WHOLE file's content in.
 * 3. Change MUNSHI_YITH_BRIDGE_SECRET below to a random string of your choice.
 * 4. Set "Run snippet everywhere" (not "only admin" / "only front-end").
 * 5. Save and Activate.
 * 6. Put that same secret into Railway's munshi-backend variables as
 *    YITH_SYNC_SECRET, and set YITH_SYNC_URL to
 *    https://zairascollection.com/wp-json/munshi/v1/affiliates
 *
 * NOTE: this reads YITH's tables directly since YITH WooCommerce Affiliates
 * doesn't offer a public REST API. Table/column names are stable across
 * recent versions, but if the numbers here don't match YITH's own admin
 * screens after your first sync, let me know so this can be adjusted for
 * your exact plugin version.
 */

// CHANGE THIS to your own random string — must match YITH_SYNC_SECRET in Railway.
define('MUNSHI_YITH_BRIDGE_SECRET', 'change-me-yith-bridge-secret');

add_action('rest_api_init', function () {
    register_rest_route('munshi/v1', '/affiliates', array(
        'methods'  => 'GET',
        'callback' => 'munshi_get_yith_affiliates',
        'permission_callback' => function ($request) {
            $provided = (string) $request->get_header('x-munshi-secret');
            return hash_equals(MUNSHI_YITH_BRIDGE_SECRET, $provided);
        },
    ));
});

function munshi_get_yith_affiliates($request) {
    global $wpdb;
    $affiliates_table  = $wpdb->prefix . 'yith_wcaf_affiliates';
    $commissions_table = $wpdb->prefix . 'yith_wcaf_commissions';

    if ($wpdb->get_var("SHOW TABLES LIKE '$affiliates_table'") !== $affiliates_table) {
        return new WP_REST_Response(array('error' => 'YITH affiliates table not found — is the plugin active?'), 404);
    }

    $affiliates = $wpdb->get_results("SELECT ID, user_id, rate FROM $affiliates_table", ARRAY_A);
    $result = array();

    foreach ($affiliates as $a) {
        $user = get_userdata($a['user_id']);
        $name = '';
        if ($user) {
            $name = trim($user->first_name . ' ' . $user->last_name);
            if (!$name) $name = $user->display_name;
        }
        if (!$name) $name = 'Affiliate #' . $a['ID'];

        $pending = 0.0;
        $paid = 0.0;
        if ($wpdb->get_var("SHOW TABLES LIKE '$commissions_table'") === $commissions_table) {
            $pending = (float) $wpdb->get_var($wpdb->prepare(
                "SELECT COALESCE(SUM(amount),0) FROM $commissions_table WHERE affiliate_id = %d AND status IN ('pending','pending-payment')",
                $a['ID']
            ));
            $paid = (float) $wpdb->get_var($wpdb->prepare(
                "SELECT COALESCE(SUM(amount),0) FROM $commissions_table WHERE affiliate_id = %d AND status = 'paid'",
                $a['ID']
            ));
        }

        $rate = (float) $a['rate'];
        $total_commission = $pending + $paid;
        // Approximate sales generated from total commission and rate, since
        // computing exact attributed order totals needs a second join that
        // varies depending on whether the store uses WooCommerce's newer
        // order-storage tables or the older post-based orders.
        $sales = $rate > 0 ? round($total_commission / ($rate / 100), 2) : 0;

        $result[] = array(
            'affiliate_id'       => (int) $a['ID'],
            'name'               => $name,
            'rate'               => $rate,
            'sales'              => $sales,
            'commission_pending' => round($pending, 2),
            'commission_paid'    => round($paid, 2),
        );
    }

    return new WP_REST_Response($result, 200);
}
