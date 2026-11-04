using System;
using System.Threading.Tasks;
using Npgsql;

namespace CineBoutique.Inventory.Api.Tests.Infrastructure;

public sealed class TestDataSeeder
{
    private readonly NpgsqlDataSource _dataSource;

    public TestDataSeeder(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource ?? throw new ArgumentNullException(nameof(dataSource));
    }

    private const string DefaultTestShopName = "Boutique Tests";

    public async Task<Guid> CreateShopAsync(string name, string kind = "boutique")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);

        await using var connection = await _dataSource.OpenConnectionAsync().ConfigureAwait(false);

        const string lookupSql = "SELECT \"Id\" FROM \"Shop\" WHERE LOWER(\"Name\") = LOWER(@name) LIMIT 1;";
        await using (var lookup = new NpgsqlCommand(lookupSql, connection)
        {
            Parameters = { new("name", name) }
        })
        {
            var existing = await lookup.ExecuteScalarAsync().ConfigureAwait(false);
            if (existing is Guid existingId)
            {
                return existingId;
            }
        }

        var id = Guid.NewGuid();
        const string insertSql = "INSERT INTO \"Shop\" (\"Id\", \"Name\", \"Kind\") VALUES (@id, @name, @kind);";

        await using (var insert = new NpgsqlCommand(insertSql, connection)
        {
            Parameters =
            {
                new("id", id),
                new("name", name),
                new("kind", kind)
            }
        })
        {
            await insert.ExecuteNonQueryAsync().ConfigureAwait(false);
        }

        return id;
    }

    public async Task SetShopOfficeCodeAsync(Guid shopId, string? officeCode)
    {
        await using var connection = await _dataSource.OpenConnectionAsync().ConfigureAwait(false);

        const string sql = "UPDATE \"Shop\" SET \"OfficeCode\" = @officeCode WHERE \"Id\" = @id;";
        await using var command = new NpgsqlCommand(sql, connection)
        {
            Parameters =
            {
                new("id", shopId),
                new("officeCode", (object?)officeCode ?? DBNull.Value)
            }
        };

        await command.ExecuteNonQueryAsync().ConfigureAwait(false);
    }

    public async Task<Guid> CreateLocationAsync(Guid shopId, string code, string label)
    {
        if (shopId == Guid.Empty)
        {
            throw new ArgumentException("Shop identifier is required.", nameof(shopId));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        ArgumentException.ThrowIfNullOrWhiteSpace(label);

        var id = Guid.NewGuid();

        const string sql = "INSERT INTO \"Location\" (\"Id\", \"Code\", \"Label\", \"ShopId\") VALUES (@id, @code, @label, @shopId);";

        var connection = _dataSource.CreateConnection();
        await connection.OpenAsync().ConfigureAwait(false);
        try
        {
            using var command = new NpgsqlCommand(sql, connection)
            {
                Parameters =
                {
                    new("id", id),
                    new("code", code),
                    new("label", label),
                    new("shopId", shopId)
                }
            };

            await command.ExecuteNonQueryAsync().ConfigureAwait(false);
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        return id;
    }

    public async Task<Guid> CreateShopUserAsync(Guid shopId, string login, string displayName, bool isAdmin = false)
    {
        if (shopId == Guid.Empty)
        {
            throw new ArgumentException("Shop identifier is required.", nameof(shopId));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(login);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);

        var id = Guid.NewGuid();

        const string sql =
            "INSERT INTO \"ShopUser\" (\"Id\", \"ShopId\", \"Login\", \"DisplayName\", \"IsAdmin\", \"Secret_Hash\", \"Disabled\") " +
            "VALUES (@id, @shopId, @login, @displayName, @isAdmin, @secret, FALSE);";

        var connection = _dataSource.CreateConnection();
        await connection.OpenAsync().ConfigureAwait(false);
        try
        {
            using var command = new NpgsqlCommand(sql, connection)
            {
                Parameters =
                {
                    new("id", id),
                    new("shopId", shopId),
                    new("login", login),
                    new("displayName", displayName),
                    new("isAdmin", isAdmin),
                    new("secret", "test-secret")
                }
            };

            await command.ExecuteNonQueryAsync().ConfigureAwait(false);
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        return id;
    }

    public async Task<Guid> GetDefaultShopIdAsync()
    {
        const string sql = "SELECT \"Id\" FROM \"Shop\" ORDER BY LOWER(\"Name\"), \"Id\" LIMIT 1;";

        await using var connection = await _dataSource.OpenConnectionAsync().ConfigureAwait(false);
        await using var command = new NpgsqlCommand(sql, connection);
        var result = await command.ExecuteScalarAsync().ConfigureAwait(false);

        if (result is Guid id)
        {
            return id;
        }

        return await CreateShopAsync(DefaultTestShopName).ConfigureAwait(false);
    }

    public async Task<Guid> CreateProductAsync(Guid shopId, string sku, string name, string? ean = null)
    {
        if (shopId == Guid.Empty)
        {
            throw new ArgumentException("Shop identifier is required.", nameof(shopId));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(sku);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        var id = Guid.NewGuid();

        const string sql =
            "INSERT INTO \"Product\" (\"Id\", \"ShopId\", \"Sku\", \"Name\", \"Ean\", \"CreatedAtUtc\") VALUES (@id, @shopId, @sku, @name, @ean, @createdAt);";

        var connection = _dataSource.CreateConnection();
        await connection.OpenAsync().ConfigureAwait(false);
        try
        {
            using var command = new NpgsqlCommand(sql, connection)
            {
                Parameters =
                {
                    new("id", id),
                    new("shopId", shopId),
                    new("sku", sku),
                    new("name", name),
                    new("ean", (object?)ean ?? DBNull.Value),
                    new("createdAt", DateTimeOffset.UtcNow)
                }
            };

            await command.ExecuteNonQueryAsync().ConfigureAwait(false);
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        return id;
    }

    public async Task<long> CreateProductGroupAsync(string label, long? parentId = null, string? code = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(label);

        const string sql =
            "INSERT INTO \"ProductGroup\" (\"Label\", \"ParentId\", \"Code\") VALUES (@label, @parentId, @code) RETURNING \"Id\";";

        var connection = _dataSource.CreateConnection();
        await connection.OpenAsync().ConfigureAwait(false);
        try
        {
            using var command = new NpgsqlCommand(sql, connection)
            {
                Parameters =
                {
                    new("label", label),
                    new("parentId", parentId.HasValue ? parentId.Value : DBNull.Value),
                    new("code", code is null ? DBNull.Value : code)
                }
            };

            var result = await command.ExecuteScalarAsync().ConfigureAwait(false);
            return Convert.ToInt64(result);
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async Task AssignProductToGroupAsync(Guid shopId, string sku, long groupId)
    {
        if (shopId == Guid.Empty)
        {
            throw new ArgumentException("Shop identifier is required.", nameof(shopId));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(sku);
        if (groupId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(groupId));
        }

        const string sql = "UPDATE \"Product\" SET \"GroupId\" = @groupId WHERE \"ShopId\" = @shopId AND \"Sku\" = @sku;";

        var connection = _dataSource.CreateConnection();
        await connection.OpenAsync().ConfigureAwait(false);
        try
        {
            using var command = new NpgsqlCommand(sql, connection)
            {
                Parameters =
                {
                    new("groupId", groupId),
                    new("shopId", shopId),
                    new("sku", sku)
                }
            };

            var affected = await command.ExecuteNonQueryAsync().ConfigureAwait(false);
            if (affected == 0)
            {
                throw new InvalidOperationException($"Aucun produit avec le SKU '{sku}' n'a été mis à jour pour le shop {shopId}.");
            }
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
        }
    }
}
