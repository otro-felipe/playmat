package mage.server.websocket.api;

import mage.server.User;
import mage.server.playtesting.ProductGateway;
import mage.server.recovery.RecoveryPrincipal;
import java.util.stream.Collectors;
import mage.server.recovery.PvpRecovery;
import mage.server.websocket.rpc.*;
import java.util.Arrays;
import java.util.List;
import static mage.server.websocket.rpc.RpcParam.Type.*;
import static mage.server.websocket.rpc.RpcParam.of;

final class RecoveryApi {
    private static User user(ApiContext ctx, RpcCall call) throws RpcException {
        return ctx.managers.sessionManager().getSession(call.sessionId())
                .flatMap(s -> ctx.managers.userManager().getUser(s.getUserId()))
                .orElseThrow(() -> RpcException.notAuthorized("Sign in first"));
    }
    static boolean sameTable(String scopedTable, PvpRecovery.RecoveryView view) {
        return scopedTable == null || scopedTable.equals(view.originalTableId) || scopedTable.equals(view.tableId);
    }

    private static PvpRecovery.RecoveryView authorizedStatus(ApiContext ctx, RpcCall call) throws RpcException {
        PvpRecovery.RecoveryView view = PvpRecovery.status(call.uuid(0), user(ctx, call));
        if (!sameTable(call.getConnection().getHumanTable(), view)) {
            throw RpcException.notAuthorized("This recovery belongs to another table");
        }
        return view;
    }

    static List<RpcMethod> methods(ApiContext ctx) {
        return Arrays.asList(
                RpcMethod.named("recoveryList").returns("RecoveryView[]")
                        .doc("Your durable private PvP matches and stable recovery links, authorized to this exact account or agent grant.")
                        .handler(call -> PvpRecovery.list(user(ctx, call)).stream()
                                .filter(view -> sameTable(call.getConnection().getHumanTable(), view)).collect(Collectors.toList())),
                RpcMethod.named("recoveryStatus").params(of("matchId", STRING)).returns("RecoveryView")
                        .doc("Only confirmed recovery metadata and ID mapping. No checkpoint payload or opponent hidden information.")
                        .handler(call -> authorizedStatus(ctx, call)),
                RpcMethod.named("recoveryJoin").params(of("matchId", STRING),of("revision",INT),of("agree",BOOLEAN)).returns("RecoveryView")
                        .doc("Explicitly agree to the displayed durable boundary. Restores once both exact admitted participants agree and connect. Repeated calls reuse one table.")
                        .handler(call -> {
                            PvpRecovery.RecoveryView view = authorizedStatus(ctx, call);
                            RecoveryPrincipal principal = call.getConnection().getRecoveryPrincipal();
                            if (call.getConnection().getHumanTable() == null && principal != null && principal.seatId.startsWith("human:")
                                    && !ProductGateway.humanBrowserMayPlay(principal, java.util.UUID.fromString(view.originalTableId))) {
                                throw RpcException.notAuthorized("This human seat is controlled by MCP");
                            }
                            return PvpRecovery.join(ctx.managers, ctx.server, call.sessionId(), user(ctx, call),
                                    call.uuid(0), call.integer(1), call.bool(2));
                        })
        );
    }
}
