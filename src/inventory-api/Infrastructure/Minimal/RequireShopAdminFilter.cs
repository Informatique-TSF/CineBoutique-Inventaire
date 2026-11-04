using CineBoutique.Inventory.Infrastructure.Database;
using Dapper;

namespace CineBoutique.Inventory.Api.Infrastructure.Minimal;

/// <summary>
/// Réserve une action d'administration à un administrateur réel de la boutique visée.
/// L'en-tête <c>X-Admin</c> est déclaré par le navigateur et ne prouve rien : ce filtre vérifie en base que
/// l'opérateur (<c>X-Operator-Id</c>) est un utilisateur actif, administrateur de la boutique ciblée
/// (paramètre de route ou de requête <c>shopId</c>, sinon <c>X-Operator-ShopId</c>, sinon n'importe quelle boutique).
/// Limite : l'application n'authentifie pas les utilisateurs (choix dans une liste, sans mot de passe) ;
/// ce contrôle empêche les appels avec un opérateur inventé ou non administrateur, pas l'usurpation d'un admin existant.
/// </summary>
internal sealed class RequireShopAdminFilter : IEndpointFilter
{
    /// <summary>Mettre à <c>false</c> uniquement dans les tests d'intégration génériques.</summary>
    internal const string VerifyShopAdminSetting = "Authorization:VerifyShopAdmin";

    private const string IsShopAdminSql = """
SELECT EXISTS (
    SELECT 1
    FROM "ShopUser"
    WHERE "Id" = @OperatorId
      AND "IsAdmin" = TRUE
      AND "Disabled" = FALSE
      AND (@ShopId::uuid IS NULL OR "ShopId" = @ShopId::uuid)
);
""";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var httpContext = context.HttpContext;
        var configuration = httpContext.RequestServices.GetRequiredService<IConfiguration>();
        if (!configuration.GetValue(VerifyShopAdminSetting, defaultValue: true))
        {
            return await next(context).ConfigureAwait(false);
        }

        if (!Guid.TryParse(httpContext.Request.Headers["X-Operator-Id"].ToString(), out var operatorId) || operatorId == Guid.Empty)
        {
            return Forbidden("L'opérateur n'est pas identifié : sélectionnez à nouveau votre utilisateur.");
        }

        var shopId = ResolveTargetShopId(httpContext);

        var connectionFactory = httpContext.RequestServices.GetRequiredService<IDbConnectionFactory>();
        var connection = await connectionFactory
            .CreateOpenConnectionAsync(httpContext.RequestAborted)
            .ConfigureAwait(false);

        bool isShopAdmin;
        await using (connection.ConfigureAwait(false))
        {
            isShopAdmin = await connection
                .ExecuteScalarAsync<bool>(new CommandDefinition(
                    IsShopAdminSql,
                    new { OperatorId = operatorId, ShopId = shopId },
                    cancellationToken: httpContext.RequestAborted))
                .ConfigureAwait(false);
        }

        if (!isShopAdmin)
        {
            return Forbidden(shopId is null
                ? "Action réservée aux administrateurs."
                : "Action réservée aux administrateurs de cette boutique.");
        }

        return await next(context).ConfigureAwait(false);
    }

    private static Guid? ResolveTargetShopId(HttpContext httpContext)
    {
        if (httpContext.Request.RouteValues.TryGetValue("shopId", out var routeValue) &&
            Guid.TryParse(routeValue?.ToString(), out var routeShopId))
        {
            return routeShopId;
        }

        if (Guid.TryParse(httpContext.Request.Query["shopId"].ToString(), out var queryShopId))
        {
            return queryShopId;
        }

        if (Guid.TryParse(httpContext.Request.Headers["X-Operator-ShopId"].ToString(), out var operatorShopId))
        {
            return operatorShopId;
        }

        return null;
    }

    private static IResult Forbidden(string detail) =>
        Results.Problem(title: "Accès refusé", detail: detail, statusCode: StatusCodes.Status403Forbidden);
}
