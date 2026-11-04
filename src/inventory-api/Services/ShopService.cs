using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Services.Exceptions;
using CineBoutique.Inventory.Infrastructure.Database;
using Dapper;
using Npgsql;

namespace CineBoutique.Inventory.Api.Services;

public sealed class ShopService : IShopService
{
    private readonly IDbConnectionFactory _connectionFactory;

    public ShopService(IDbConnectionFactory connectionFactory)
    {
        _connectionFactory = connectionFactory ?? throw new ArgumentNullException(nameof(connectionFactory));
    }

    public async Task<IReadOnlyList<ShopDto>> GetAsync(string? kind, CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        const string baseSql = """
        SELECT "Id", "Name", "Kind", "OfficeCode"
        FROM "Shop"
        ORDER BY LOWER("Name");
        """;

        const string filteredSql = """
        SELECT "Id", "Name", "Kind", "OfficeCode"
        FROM "Shop"
        WHERE lower("Kind") = lower(@Kind)
        ORDER BY LOWER("Name");
        """;

        var hasKind = !string.IsNullOrWhiteSpace(kind);
        var sql = hasKind ? filteredSql : baseSql;
        var parameters = hasKind ? new { Kind = kind } : null;

        var shops = await connection.QueryAsync<ShopDto>(
            new CommandDefinition(sql, parameters, cancellationToken: cancellationToken)).ConfigureAwait(false);

        return shops.ToList();
    }

    public async Task<ShopDto> CreateAsync(CreateShopRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var trimmedName = request.Name.Trim();

        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            const string sql = """
            INSERT INTO "Shop" ("Name")
            VALUES (@Name)
            RETURNING "Id", "Name", "Kind", "OfficeCode";
            """;

            var created = await connection.QuerySingleAsync<ShopDto>(
                    new CommandDefinition(sql, new { Name = trimmedName }, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            return created;
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new ShopConflictException($"Une boutique nommée '{trimmedName}' existe déjà.");
        }
    }

    public async Task<ShopDto> UpdateAsync(UpdateShopRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var trimmedName = request.Name.Trim();

        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            // OfficeCode absent de la requête : le code actuel est conservé. Chaîne vide : le code est effacé.
            const string sql = """
            UPDATE "Shop"
            SET "Name" = @Name,
                "OfficeCode" = CASE WHEN @UpdateOfficeCode THEN @OfficeCode ELSE "OfficeCode" END
            WHERE "Id" = @Id
            RETURNING "Id", "Name", "Kind", "OfficeCode";
            """;

            var updateOfficeCode = request.OfficeCode is not null;
            var officeCode = NormalizeOfficeCode(request.OfficeCode);

            var updated = await connection.QuerySingleOrDefaultAsync<ShopDto>(
                    new CommandDefinition(
                        sql,
                        new { request.Id, Name = trimmedName, UpdateOfficeCode = updateOfficeCode, OfficeCode = officeCode },
                        cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            if (updated is null)
            {
                throw new ShopNotFoundException();
            }

            return updated;
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new ShopConflictException($"Une boutique nommée '{trimmedName}' existe déjà.");
        }
    }

    internal static string? NormalizeOfficeCode(string? officeCode)
    {
        if (string.IsNullOrWhiteSpace(officeCode))
        {
            return null;
        }

        return officeCode.Trim().ToUpperInvariant();
    }

    public async Task<ShopDto> DeleteAsync(DeleteShopRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            const string selectSql = """
            SELECT "Id", "Name", "Kind", "OfficeCode"
            FROM "Shop"
            WHERE "Id" = @Id
            FOR UPDATE;
            """;

            var existing = await connection.QuerySingleOrDefaultAsync<ShopDto>(
                    new CommandDefinition(selectSql, new { request.Id }, transaction, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            if (existing is null)
            {
                throw new ShopNotFoundException();
            }

            const string occupancySql = """
            SELECT
                (SELECT COUNT(*) FROM "Location" WHERE "ShopId" = @Id) AS LocationCount,
                (SELECT COUNT(*) FROM "ShopUser" WHERE "ShopId" = @Id) AS UserCount;
            """;

            var occupancy = await connection.QuerySingleAsync<ShopOccupancy>(
                    new CommandDefinition(occupancySql, new { request.Id }, transaction, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            if (occupancy.LocationCount > 0 || occupancy.UserCount > 0)
            {
                throw new ShopNotEmptyException();
            }

            const string deleteSql = "DELETE FROM \"Shop\" WHERE \"Id\" = @Id;";
            await connection.ExecuteAsync(
                    new CommandDefinition(deleteSql, new { request.Id }, transaction, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);

            return existing;
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private readonly record struct ShopOccupancy(long LocationCount, long UserCount);
}
